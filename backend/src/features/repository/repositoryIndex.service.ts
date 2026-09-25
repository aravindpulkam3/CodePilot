import { pool } from "../../config/db.js";
import { safeErrorDetails } from "../../shared/utils/safeErrorDetails.js";
import { astChunker } from "../../infrastructure/chunking/astChunking.service.js";
import { documentationChunker } from "../../infrastructure/chunking/documentationChunking.service.js";
import { isConfigFile, isDocumentationFile } from "../../shared/utils/documentationPaths.js";
import { embedder } from "../../infrastructure/embedding/embedding.service.js";
import { extractLocalImports } from "../../shared/utils/importResolver.js";
import { MemoryRelationshipIndexer } from "../../shared/utils/transactionBuffer.js";
import { RelationshipIndexingService } from "./relationshipIndexing.service.js";
import { appEvents, EVENT_TYPES } from "../../shared/events/eventEmitter.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { readmeLog, docPreview } from "../../shared/utils/readmeDebugLog.js";

export interface FileChange {
  path: string;
  content: string | null;
  status: "added" | "modified" | "removed" | "renamed";
  /**
   * The path this file had BEFORE a rename. Populated only when
   * status === "renamed" (see github.service.ts#getChangedFilesBetweenCommits).
   * Without it the old path's rows would stay in the index forever, since
   * GitHub reports a renamed file under its new name only.
   */
  previousPath?: string;
}

export class RepositoryIndexingService {
  /**
   * The single indexing phase — processes a repository update by selectively
   * syncing only changed files: AST chunking (code), whole-file / section
   * chunking (config and docs), embeddings, and the IMPORTS graph. No LLM
   * calls. Once every chunk job of a sync has committed, pending imports are
   * resolved and the repo is stamped READY.
   *
   * Finalization uses a persisted chunk-completion counter, not a boolean
   * flag passed at enqueue time — indexQueue's concurrency:4 means the
   * last-*enqueued* chunk isn't reliably the last to *complete*.
   */
  public async processRepositoryUpdate(
    repositoryId: string,
    commitSha: string,
    changedFiles: FileChange[],
    runId: string,
    chunkIndex: number,
  ) {
    console.log(
      `[Index] processRepositoryUpdate started for repo ${repositoryId}: ${changedFiles.length} file(s).`,
    );

    // --- STAGE 1: OUTSIDE TRANSACTION (Generation) ---

    // Capture consistency snapshot
    const { rows: repoRows } = await pool.query(
      "SELECT last_indexed_sha, user_id, indexing_run_id, indexing_target_sha, completed_index_chunks FROM repositories WHERE id = $1",
      [repositoryId],
    );
    const currentRun = repoRows[0];
    if (!currentRun || currentRun.indexing_run_id !== runId || currentRun.indexing_target_sha !== commitSha
      || currentRun.completed_index_chunks.includes(chunkIndex)) return;
    await astChunker.init();
    const snapshotSha = currentRun.last_indexed_sha;
    const ownerUserId = repoRows[0]?.user_id;
    console.log(
      `[Index] Snapshot SHA for ${repositoryId}: ${snapshotSha || "(none — initial index)"}.`,
    );

    const chunksToDelete: { filePath: string; contentHashes: string[] }[] = [];
    const chunksToInsert: any[] = [];
    const hashesToKeepUpdate: { filePath: string; contentHashes: string[] }[] =
      [];

    const memRelationshipIndexer = new MemoryRelationshipIndexer();

    // "Known paths" for import resolution: every file already indexed for this repo, plus every non-removed file in this chunk. Relationship edges pointing at files outside this set are treated as external (not yet indexed, or a real external package) by extractLocalImports.
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
        await memRelationshipIndexer.deleteFileRelationships(
          repositoryId,
          file.path,
        );
        continue;
      }

      // A rename is a delete of the OLD path plus a full index of the new one. Deliberately NOT deleteFileRelationships here: that clears edges where
      // the old path is source OR target, and the incoming half can't be rebuilt from this sync — an importer only shows up in changedFiles if
      // its own bytes changed, which a case-only / extension-only /
      // file-to-index rename doesn't require. renameFileRelationships drops
      // the old outgoing edges (rebuilt below from the new content) and
      // RETARGETS the incoming ones onto the new path instead.
      // No `continue` — the new path still needs chunking/embedding/linking.
      if (file.status === "renamed" && file.previousPath) {
        chunksToDelete.push({ filePath: file.previousPath, contentHashes: [] });
        await memRelationshipIndexer.renameFileRelationships(
          repositoryId,
          file.previousPath,
          file.path,
        );
      }

      if (!file.content) continue;

      // Documentation (README) is chunked by Markdown structure rather than by AST — but into the SAME table, in this SAME transaction, stamped
      // with this SAME commitSha as the code chunks around it. That is what
      // guarantees retrieval can never serve README content from a different
      // revision than the code it is reasoned about alongside.
      // Config files (package.json, docker-compose, .env.example, ...) are stored
      // as one byte-exact whole-file row; prose docs are split by headings.
      // Both are symbol_type 'documentation' — see utils/documentationPaths.ts.
      const isConfig = isConfigFile(file.path);
      const isDoc = isConfig || isDocumentationFile(file.path);

      if (isDoc) {
        readmeLog(
          `Detected documentation file "${file.path}" (status=${file.status}, ${file.content.length} chars) in repo ${repositoryId} @ ${commitSha}.`,
        );
      }

      const newChunks = isConfig
        ? await documentationChunker.chunkWholeFile(file.path, file.content)
        : isDoc
          ? await documentationChunker.chunkDocument(file.path, file.content)
          : await astChunker.chunkFile(file.path, file.content);
      const newHashes = new Set(newChunks.map((c) => c.content_hash));

      if (isDoc) {
        readmeLog(
          `Chunked "${file.path}" into ${newChunks.length} section(s):`,
        );
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

      // Import/relationship graph (Review's graph expansion, Q&A's graph
      // augmentation and Interview's neighbours read repository_relationships).
      // Skipped for documentation and config: they have no imports to resolve,
      // and extractFileAstMetadata would return null for them anyway.
      if (!isDoc) {
        const astMeta = await astChunker.extractFileAstMetadata(
          file.path,
          file.content,
        );
        if (astMeta) {
          const localImports = extractLocalImports(
            astMeta.filePath,
            astMeta.imports,
            knownPaths,
          );
          await memRelationshipIndexer.indexFileRelationships(
            repositoryId,
            astMeta.filePath,
            localImports,
          );
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
        "SELECT last_indexed_sha, indexing_run_id, indexing_target_sha, completed_index_chunks FROM repositories WHERE id = $1 FOR UPDATE",
        [repositoryId],
      );
      const currentSha = currentRepoRows[0]?.last_indexed_sha;

      const lockedRepo = currentRepoRows[0];
      if (!lockedRepo || currentSha !== snapshotSha || lockedRepo.indexing_run_id !== runId
        || lockedRepo.indexing_target_sha !== commitSha || lockedRepo.completed_index_chunks.includes(chunkIndex)) {
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
                    (repository_id, commit_sha, file_path, language, symbol_type, symbol_name, start_line, end_line, content_hash, content, embedding, qualified_name, parent_symbol, docstring, is_exported, chunk_index, chunk_total)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
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
            chunk.qualified_name ?? null,
            chunk.parent_symbol ?? null,
            chunk.docstring ?? null,
            chunk.is_exported ?? null,
            chunk.chunk_index ?? null,
            chunk.chunk_total ?? null,
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
      // Renames first: retargeting incoming edges has to happen while the old
      // path's rows are still present, before any delete can remove them.
      for (const { oldPath, newPath } of memRelationshipIndexer.pendingRenames) {
        await realTxRelIndexer.renameFileRelationships(
          repositoryId,
          oldPath,
          newPath,
        );
      }
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
      // enqueued for this sync has completed, finalize READY. Using a
      // counter instead of an "isFinalChunk" flag matters because
      // indexQueue's concurrency:4 means the last-*enqueued* chunk isn't
      // reliably the last to *complete*.
      const { rows: progressRows } = await client.query(
        `UPDATE repositories
         SET index_chunks_done = index_chunks_done + 1,
             index_files_done = index_files_done + $2,
             completed_index_chunks = array_append(completed_index_chunks, $3)
         WHERE id = $1
         RETURNING index_chunks_done, index_chunks_total`,
        [repositoryId, changedFiles.length, chunkIndex],
      );
      const { index_chunks_done: chunksDone, index_chunks_total: chunksTotal } =
        progressRows[0];
      const isFinalChunk = chunksTotal != null && chunksDone >= chunksTotal;

      if (isFinalChunk) {
        // Every chunk of this sync has committed (counter above), so the
        // file list is now complete: resolve the relative imports that
        // pointed into a later chunk and were recorded as pending. Pure SQL
        // plus in-memory path matching — no network, safe inside the tx.
        const { pending, resolved } = await realTxRelIndexer.resolvePendingImports(repositoryId);
        console.log(
          `[Index] Pending imports for ${repositoryId}: resolved ${resolved} of ${pending}.`,
        );

        await client.query(
          `UPDATE repositories
           SET last_indexed_sha = $1,
               searchable_at = COALESCE(searchable_at, NOW()),
               indexing_status = 'READY'
           WHERE id = $2`,
          [commitSha, repositoryId],
        );
        console.log(
          `[Index] Repo ${repositoryId} marked READY at ${commitSha}.`,
        );
      }

      await client.query("COMMIT");
      console.log(
        `[Index] Transaction committed for ${repositoryId} (chunk ${chunksDone}/${chunksTotal}).`,
      );

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

      if (isFinalChunk) {
        // This is the actual completion point for a chunked sync — the
        // chunk-completion counter above just confirmed every enqueued
        // chunk committed and the repo is now READY. Emitting here
        // (rather than at enqueue time in repositorySync.service.ts) is
        // what stops invalidation from firing before the new data exists.
        appEvents.emit(EVENT_TYPES.REPOSITORY_SYNCED, {
          userId: ownerUserId,
          repositoryId,
        });
      }
    } catch (error) {
      console.error(
        `[Index] Error during indexing transaction for ${repositoryId}:`,
        safeErrorDetails(error),
      );
      try {
        await client.query("ROLLBACK");
      } catch (e) {
        console.error(`[Index] Rollback failed for ${repositoryId}:`, safeErrorDetails(e));
      }
      // The worker marks FAILED only after BullMQ has stopped retrying.
      throw error;
    } finally {
      client.release();
    }
  }
}
export const repositoryIndexer = new RepositoryIndexingService();
