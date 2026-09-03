import { pool } from "../config/db.js";
import { astChunker } from "./astChunking.service.js";
import { embedder } from "./embedding.service.js";
import { updateSummariesIncrementally, runSummarizationPipeline } from "./summaryPipeline.service.js";
import { PgSummaryStore } from "../utils/pgSummaryStore.js";
import { ollamaService } from "./llm.service.js";
import {
  MemorySummaryStore,
  MemoryRelationshipIndexer,
} from "../utils/transactionBuffer.js";
import { RelationshipIndexingService } from "./relationshipIndexing.service.js";

export interface FileChange {
  path: string;
  content: string | null;
  status: "added" | "modified" | "removed" | "renamed";
}

export class RepositoryIndexingService {
  /**
   * Processes a repository update by selectively syncing only changed files.
   * Uses AST hashing to skip redundant API calls and performs Orphan Cleanup.
   */
  public async processRepositoryUpdate(
    repositoryId: string,
    commitSha: string,
    changedFiles: FileChange[],
    isFinalChunk: boolean = true
  ) {
    await astChunker.init();
    console.log(`Processing index chunk for repo ${repositoryId}. Final chunk? ${isFinalChunk}`);

    // Lock indexing status (non-transactional for now, just a flag)
    await pool.query(
      `UPDATE repositories SET indexing_status = 'INDEXING' WHERE id = $1`,
      [repositoryId],
    );

    // --- STAGE 1: OUTSIDE TRANSACTION (Generation) ---

    // Capture consistency snapshot
    const { rows: repoRows } = await pool.query(
      "SELECT last_indexed_sha FROM repositories WHERE id = $1",
      [repositoryId],
    );
    const snapshotSha = repoRows[0]?.last_indexed_sha;

    const chunksToDelete: { filePath: string; contentHashes: string[] }[] = [];
    const chunksToInsert: any[] = [];
    const hashesToKeepUpdate: { filePath: string; contentHashes: string[] }[] =
      [];

    for (const file of changedFiles) {
      if (file.status === "removed") {
        chunksToDelete.push({ filePath: file.path, contentHashes: [] }); // Empty array means delete all for file
        continue;
      }

      if (!file.content) continue;

      const newChunks = await astChunker.chunkFile(file.path, file.content);
      const newHashes = new Set(newChunks.map((c) => c.content_hash));

      const { rows } = await pool.query(
        `SELECT content_hash FROM repository_embeddings 
                 WHERE repository_id = $1 AND file_path = $2`,
        [repositoryId, file.path],
      );
      const existingHashes = new Set(rows.map((r) => r.content_hash));

      const hashesToDelete = [...existingHashes].filter(
        (h) => !newHashes.has(h),
      );
      if (hashesToDelete.length > 0) {
        chunksToDelete.push({
          filePath: file.path,
          contentHashes: hashesToDelete,
        });
      }

      const chunksToEmbed = newChunks.filter(
        (c) => !existingHashes.has(c.content_hash),
      );
      if (chunksToEmbed.length > 0) {
        const embeddedChunks = await embedder.generateEmbeddings(chunksToEmbed);
        chunksToInsert.push(...embeddedChunks);
      }

      const hashesToKeep = [...existingHashes].filter((h) => newHashes.has(h));
      if (hashesToKeep.length > 0) {
        hashesToKeepUpdate.push({
          filePath: file.path,
          contentHashes: hashesToKeep,
        });
      }
    }

    const realStore = new PgSummaryStore(pool);
    const memStore = new MemorySummaryStore(realStore);
    const memRelationshipIndexer = new MemoryRelationshipIndexer();

    if (!snapshotSha) {
      console.log("Triggering INITIAL summarization (full pipeline)...");
      const initialFiles = changedFiles
        .filter((f) => f.status !== "removed" && f.content !== null)
        .map((f) => ({ path: f.path, source: f.content! }));

      await runSummarizationPipeline(
        {
          repositoryId,
          files: initialFiles,
          readme: null,
          packageMetadata: null,
        },
        {
          llm: ollamaService,
          embeddings: embedder,
          store: memStore,
          relationshipIndexer: memRelationshipIndexer,
          useLLMModuleRefinement: false,
        },
      );
      console.log("Initial summarization completed.");
    } else {
      console.log("Triggering incremental summarization...");
      await updateSummariesIncrementally(
        {
          repositoryId,
          changedFiles,
          readme: null,
          packageMetadata: null,
        },
        {
          llm: ollamaService,
          embeddings: embedder,
          store: memStore,
          relationshipIndexer: memRelationshipIndexer,
        },
      );
      console.log("Incremental summarization completed.");
    }

    // --- STAGE 2: SHORT TRANSACTION (Persistence) ---
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Verify snapshot
      const { rows: currentRepoRows } = await client.query(
        "SELECT last_indexed_sha FROM repositories WHERE id = $1",
        [repositoryId],
      );
      const currentSha = currentRepoRows[0]?.last_indexed_sha;

      if (currentSha !== snapshotSha) {
        console.warn(
          `[RepositoryIndexingService] Stale generation detected for ${repositoryId}. Aborting transaction.`,
        );
        await client.query("ROLLBACK");
        return;
      }

      // 2. Apply Chunks
      for (const del of chunksToDelete) {
        if (del.contentHashes.length === 0) {
          await client.query(
            `DELETE FROM repository_embeddings WHERE repository_id = $1 AND file_path = $2`,
            [repositoryId, del.filePath],
          );
        } else {
          await client.query(
            `DELETE FROM repository_embeddings WHERE repository_id = $1 AND file_path = $2 AND content_hash = ANY($3)`,
            [repositoryId, del.filePath, del.contentHashes],
          );
        }
      }

      for (const chunk of chunksToInsert) {
        const embeddingVectorStr = `[${chunk.embedding.join(",")}]`;
        await client.query(
          `INSERT INTO repository_embeddings 
                    (repository_id, commit_sha, file_path, language, symbol_type, symbol_name, start_line, end_line, content_hash, content, embedding)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            repositoryId,
            commitSha,
            chunk.file_path,
            chunk.language,
            chunk.symbol_type,
            chunk.symbol_name,
            chunk.start_line,
            chunk.end_line,
            chunk.content_hash,
            chunk.content,
            embeddingVectorStr,
          ],
        );
      }

      for (const update of hashesToKeepUpdate) {
        await client.query(
          `UPDATE repository_embeddings SET commit_sha = $1, updated_at = CURRENT_TIMESTAMP 
                     WHERE repository_id = $2 AND file_path = $3 AND content_hash = ANY($4)`,
          [commitSha, repositoryId, update.filePath, update.contentHashes],
        );
      }

      // 3. Apply Summaries
      const realTxStore = new PgSummaryStore(client);
      for (const del of memStore.pendingDeletes.values()) {
        await realTxStore.delete(del.repositoryId, del.nodeType, del.nodeKey);
      }
      for (const upsert of memStore.pendingUpserts.values()) {
        await realTxStore.upsert(upsert);
      }

      // 4. Apply Relationships
      const realTxRelIndexer = new RelationshipIndexingService(client);
      for (const filePath of memRelationshipIndexer.pendingDeletes) {
        await realTxRelIndexer.deleteFileRelationships(repositoryId, filePath);
      }
      for (const [
        filePath,
        imports,
      ] of memRelationshipIndexer.pendingImports.entries()) {
        await realTxRelIndexer.indexFileRelationships(
          repositoryId,
          filePath,
          imports,
        );
      }

      // 5. Finalize indexing status ONLY if this is the final chunk
      if (isFinalChunk) {
        await client.query(
          `UPDATE repositories SET last_indexed_sha = $1, indexing_status = 'INDEXED' WHERE id = $2`,
          [commitSha, repositoryId],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error during repository indexing transaction:", error);
      try {
        await pool.query(
          `UPDATE repositories SET indexing_status = 'FAILED' WHERE id = $1`,
          [repositoryId],
        );
      } catch (e) {
        console.error("Failed to update error status:", e);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
export const repositoryIndexer = new RepositoryIndexingService();
