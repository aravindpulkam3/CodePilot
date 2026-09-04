import { pool } from "../config/db.js";
import { astChunker } from "./astChunking.service.js";
import { documentationChunker } from "./documentationChunking.service.js";
import { isDocumentationFile } from "../utils/documentationPaths.js";
import { embedder } from "./embedding.service.js";
import { extractLocalImports } from "../utils/importResolver.js";
import {
  MemoryRelationshipIndexer,
} from "../utils/transactionBuffer.js";
import { RelationshipIndexingService } from "./relationshipIndexing.service.js";
import { repositorySummarizeService } from "./repositorySummarize.service.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { readmeLog, docPreview } from "../utils/readmeDebugLog.js";

export interface FileChange {
  path: string;
  content: string | null;
  status: "added" | "modified" | "removed" | "renamed";
}

export class RepositoryIndexingService {
  /**
   * Phase 1 — Processes a repository update by selectively syncing only
   * changed files: AST-chunking, embedding, and the import/relationship
   * graph (relocated here from the summarization pipeline — Q&A/Review
   * read the graph too, so it has to exist by SEARCHABLE, not just by
   * READY). LLM summarization is Phase 2 (repositorySummarize.service.ts),
   * entirely decoupled and running in the background afterward.
   *
   * Finalization uses a persisted chunk-completion counter, not a boolean
   * flag passed at enqueue time — indexQueue's concurrency:4 means the
   * last-*enqueued* chunk isn't reliably the last to *complete*.
   */
  public async processRepositoryUpdate(
    repositoryId: string,
    commitSha: string,
    changedFiles: FileChange[],
  ) {
    console.log(
      `[Index] processRepositoryUpdate started for repo ${repositoryId}: ${changedFiles.length} file(s).`,
    );
    await astChunker.init();

    // --- STAGE 1: OUTSIDE TRANSACTION (Generation) ---

    // Capture consistency snapshot
    const { rows: repoRows } = await pool.query(
      "SELECT last_indexed_sha FROM repositories WHERE id = $1",
      [repositoryId],
    );
    const snapshotSha = repoRows[0]?.last_indexed_sha;
    console.log(`[Index] Snapshot SHA for ${repositoryId}: ${snapshotSha || "(none — initial index)"}.`);

    const chunksToDelete: { filePath: string; contentHashes: string[] }[] = [];
    const chunksToInsert: any[] = [];
    const hashesToKeepUpdate: { filePath: string; contentHashes: string[] }[] =
      [];

    const memRelationshipIndexer = new MemoryRelationshipIndexer();

    // "Known paths" for import resolution: every file already indexed for
    // this repo, plus every non-removed file in this chunk. Relationship
    // edges pointing at files outside this set are treated as external
    // (not yet indexed, or a real external package) by extractLocalImports.
    const { rows: knownFileRows } = await pool.query(
      `SELECT DISTINCT file_path FROM repository_embeddings WHERE repository_id = $1`,
      [repositoryId],
    );
    const knownPaths = new Set(knownFileRows.map((r) => r.file_path));
    for (const f of changedFiles) {
      if (f.status !== "removed") knownPaths.add(f.path);
    }

    for (const file of changedFiles) {
      if (file.status === "removed") {
        chunksToDelete.push({ filePath: file.path, contentHashes: [] }); // Empty array means delete all for file
        await memRelationshipIndexer.deleteFileRelationships(repositoryId, file.path);
        continue;
      }

      if (!file.content) continue;

      // Documentation (README) is chunked by Markdown structure rather than
      // by AST — but into the SAME table, in this SAME transaction, stamped
      // with this SAME commitSha as the code chunks around it. That is what
      // guarantees retrieval can never serve README content from a different
      // revision than the code it is reasoned about alongside.
      const isDoc = isDocumentationFile(file.path);

      if (isDoc) {
        readmeLog(
          `Detected documentation file "${file.path}" (status=${file.status}, ${file.content.length} chars) in repo ${repositoryId} @ ${commitSha}.`,
        );
      }

      const newChunks = isDoc
        ? await documentationChunker.chunkDocument(file.path, file.content)
        : await astChunker.chunkFile(file.path, file.content);
      const newHashes = new Set(newChunks.map((c) => c.content_hash));

      if (isDoc) {
        readmeLog(`Chunked "${file.path}" into ${newChunks.length} section(s):`);
        newChunks.forEach((c, i) => {
          readmeLog(
            `  [${i + 1}/${newChunks.length}] § "${c.symbol_name}" ` +
              `lines ${c.start_line}-${c.end_line} hash=${c.content_hash.slice(0, 8)} :: ${docPreview(c.content)}`,
          );
        });
      }

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

      if (isDoc) {
        readmeLog(
          `"${file.path}": ${chunksToEmbed.length} new section(s) to embed, ` +
            `${newChunks.length - chunksToEmbed.length} unchanged (content-hash skip), ` +
            `${hashesToDelete.length} stale row(s) to delete.`,
        );
      }

      if (chunksToEmbed.length > 0) {
        const embeddedChunks = await embedder.generateEmbeddings(chunksToEmbed);
        if (isDoc) {
          readmeLog(
            `Embedded ${embeddedChunks.length}/${chunksToEmbed.length} section(s) of "${file.path}" ` +
              `(dim=${embeddedChunks[0]?.embedding?.length ?? "n/a"}).`,
          );
        }
        chunksToInsert.push(...embeddedChunks);
      }

      const hashesToKeep = [...existingHashes].filter((h) => newHashes.has(h));
      if (hashesToKeep.length > 0) {
        hashesToKeepUpdate.push({
          filePath: file.path,
          contentHashes: hashesToKeep,
        });
      }

      // Import/relationship graph — relocated from the summarization
      // pipeline so it exists by SEARCHABLE, not just by READY (Review's
      // graph-expansion stage reads repository_relationships directly).
      // Skipped for documentation: Markdown has no imports to resolve, and
      // extractFileAstMetadata would return null for it anyway.
      if (!isDoc) {
        const astMeta = await astChunker.extractFileAstMetadata(file.path, file.content);
        if (astMeta) {
          const localImports = extractLocalImports(astMeta.filePath, astMeta.imports, knownPaths);
          await memRelationshipIndexer.indexFileRelationships(repositoryId, astMeta.filePath, localImports);
        }
      }
    }

    console.log(
      `[Index] Generation complete for ${repositoryId}: ${chunksToInsert.length} chunk(s) to insert, ${chunksToDelete.length} file(s) with deletions, ${hashesToKeepUpdate.length} file(s) unchanged.`,
    );

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

      // 3. Apply Relationships
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

      // 4. Advance the chunk-completion counter and, only once every chunk
      // enqueued for this sync has completed, finalize SEARCHABLE. Using a
      // counter instead of an "isFinalChunk" flag matters because
      // indexQueue's concurrency:4 means the last-*enqueued* chunk isn't
      // reliably the last to *complete*.
      const { rows: progressRows } = await client.query(
        `UPDATE repositories
         SET index_chunks_done = index_chunks_done + 1,
             index_files_done = index_files_done + $2
         WHERE id = $1
         RETURNING index_chunks_done, index_chunks_total`,
        [repositoryId, changedFiles.length],
      );
      const { index_chunks_done: chunksDone, index_chunks_total: chunksTotal } = progressRows[0];
      const isFinalChunk = chunksTotal != null && chunksDone >= chunksTotal;

      if (isFinalChunk) {
        await client.query(
          `UPDATE repositories
           SET last_indexed_sha = $1,
               searchable_at = COALESCE(searchable_at, NOW()),
               indexing_status = 'SEARCHABLE'
           WHERE id = $2`,
          [commitSha, repositoryId],
        );
        console.log(`[Index] Repo ${repositoryId} marked SEARCHABLE at ${commitSha}.`);
      }

      await client.query("COMMIT");
      console.log(`[Index] Transaction committed for ${repositoryId} (chunk ${chunksDone}/${chunksTotal}).`);

      // Doc rows are committed by this SAME transaction, at this SAME
      // commitSha, as the code rows around them — that shared stamp is what
      // guarantees retrieval can never mix README content from one revision
      // with code from another.
      const persistedDocChunks = chunksToInsert.filter(
        (c) => c.symbol_type === "documentation",
      );
      if (persistedDocChunks.length > 0) {
        readmeLog(
          `Persisted ${persistedDocChunks.length} documentation row(s) for repo ${repositoryId} ` +
            `at commit_sha=${commitSha}: ${persistedDocChunks
              .map((c) => `"${c.symbol_name}"`)
              .join(", ")}.`,
        );
      }

      // Outside the transaction — kick off Phase 2 only once Phase 1 is
      // fully done for this revision.
      if (isFinalChunk) {
        await repositorySummarizeService.enqueueSummarize(repositoryId, commitSha);
      }
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`[Index] Error during indexing transaction for ${repositoryId}:`, error);
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
