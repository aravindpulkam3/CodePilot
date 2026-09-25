import { pool } from "../../config/db.js";
import { safeErrorDetails } from "../../shared/utils/safeErrorDetails.js";
import { astChunker } from "../../infrastructure/chunking/astChunking.service.js";
import { documentationChunker } from "../../infrastructure/chunking/documentationChunking.service.js";
import { isConfigFile, isDocumentationFile, isExcludedPath } from "../../shared/utils/documentationPaths.js";
import { embedder } from "../../infrastructure/embedding/embedding.service.js";
import { extractLocalImports, type LocalImport } from "../../shared/utils/importResolver.js";
import { RelationshipIndexingService } from "./relationshipIndexing.service.js";
import { appEvents, EVENT_TYPES } from "../../shared/events/eventEmitter.js";

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

/**
 * The single rule for what the index stores: source code with a registered
 * parser, prose docs, or config files — never generated/vendored content.
 * Sync applies it before downloading anything, for full and delta syncs alike.
 */
export function isIndexableFile(filePath: string): boolean {
  if (isExcludedPath(filePath)) return false;
  return astChunker.supportsFile(filePath) || isConfigFile(filePath) || isDocumentationFile(filePath);
}

interface RunRow {
  indexing_run_id: string | null;
  indexing_target_sha: string | null;
  completed_index_chunks: number[];
}

/**
 * True while this chunk job still belongs to the repository's current run and
 * hasn't committed yet. A superseded run (new run id or target) or an already
 * receipted chunk (a retried/stalled job that did commit) must not write.
 */
function isCurrentChunk(
  row: RunRow | undefined,
  runId: string,
  commitSha: string,
  chunkIndex: number,
): boolean {
  return (
    !!row &&
    row.indexing_run_id === runId &&
    row.indexing_target_sha === commitSha &&
    !row.completed_index_chunks.includes(chunkIndex)
  );
}

export class RepositoryIndexingService {
  /**
   * The single indexing phase for one chunk job of a run: AST chunking (code),
   * whole-file / section chunking (config and docs), embeddings, and the
   * import graph. No LLM calls. The chunk that completes the run's last
   * receipt resolves pending imports and stamps the repo READY.
   *
   * Slow work (parsing, embedding) happens before the transaction; the
   * transaction re-checks the run under a row lock, writes, and records this
   * chunk's receipt atomically with those writes.
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

    // Cheap early exit so a superseded job doesn't pay for embeddings; the
    // authoritative check is repeated under the row lock in stage 2.
    const { rows: repoRows } = await pool.query(
      `SELECT user_id, indexing_run_id, indexing_target_sha, completed_index_chunks
       FROM repositories WHERE id = $1`,
      [repositoryId],
    );
    if (!isCurrentChunk(repoRows[0], runId, commitSha, chunkIndex)) return;
    const ownerUserId = repoRows[0].user_id;
    await astChunker.init();

    const chunksToDelete: { filePath: string; contentHashes: string[] }[] = [];
    const chunksToInsert: any[] = [];
    const hashesToKeepUpdate: { filePath: string; contentHashes: string[] }[] =
      [];

    // Import-graph changes, applied inside the stage 2 transaction.
    const removedPaths: string[] = [];
    const renames: { oldPath: string; newPath: string }[] = [];
    const importsByFile = new Map<string, LocalImport[]>();

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
        removedPaths.push(file.path);
        continue;
      }

      // A rename is a delete of the OLD path plus a full index of the new one. Its import edges are not deleted: the old
      // path's outgoing edges are rebuilt from the new content below, and its
      // incoming edges are RETARGETED onto the new path — an importer only shows up in changedFiles if its own bytes changed,
      // which a case-only / extension-only / file-to-index rename doesn't require.
      // No `continue` — the new path still needs chunking/embedding/linking.
      if (file.status === "renamed" && file.previousPath) {
        chunksToDelete.push({ filePath: file.previousPath, contentHashes: [] });
        renames.push({ oldPath: file.previousPath, newPath: file.path });
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

      const newChunks = isConfig
        ? await documentationChunker.chunkWholeFile(file.path, file.content)
        : isDoc
          ? await documentationChunker.chunkDocument(file.path, file.content)
          : await astChunker.chunkFile(file.path, file.content);
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

      // Import graph (Review's graph expansion, Q&A's graph augmentation and
      // Interview's neighbours read repository_imports). Skipped for
      // documentation and config: they have no imports to resolve, and
      // extractFileAstMetadata would return null for them anyway.
      if (!isDoc) {
        const astMeta = await astChunker.extractFileAstMetadata(
          file.path,
          file.content,
        );
        if (astMeta) {
          importsByFile.set(
            astMeta.filePath,
            extractLocalImports(astMeta.filePath, astMeta.imports, knownPaths),
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

      // 1. Re-check the run under the row lock. Every other writer of this
      // row (a new run's claim, finalize, the worker's FAILED update) needs
      // the same lock, so the check holds until COMMIT.
      const { rows: lockedRows } = await client.query(
        `SELECT indexing_run_id, indexing_target_sha, completed_index_chunks
         FROM repositories WHERE id = $1 FOR UPDATE`,
        [repositoryId],
      );
      if (!isCurrentChunk(lockedRows[0], runId, commitSha, chunkIndex)) {
        console.warn(
          `[RepositoryIndexingService] Stale chunk ${chunkIndex} of run ${runId} for ${repositoryId}. Aborting transaction.`,
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
                    (repository_id, commit_sha, file_path, symbol_type, symbol_name, start_line, end_line, content_hash, content, embedding, qualified_name, parent_symbol, is_exported, chunk_index, chunk_total)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            repositoryId,
            commitSha,
            chunk.file_path,
            chunk.symbol_type,
            chunk.symbol_name,
            chunk.start_line,
            chunk.end_line,
            chunk.content_hash,
            chunk.content,
            embeddingVectorStr,
            chunk.qualified_name ?? null,
            chunk.parent_symbol ?? null,
            chunk.is_exported ?? null,
            chunk.chunk_index ?? null,
            chunk.chunk_total ?? null,
          ],
        );
      }

      for (const update of hashesToKeepUpdate) {
        await client.query(
          `UPDATE repository_embeddings SET commit_sha = $1
                     WHERE repository_id = $2 AND file_path = $3 AND content_hash = ANY($4)`,
          [commitSha, repositoryId, update.filePath, update.contentHashes],
        );
      }

      // 3. Apply import-graph changes
      const importIndexer = new RelationshipIndexingService(client);
      // Renames first: retargeting incoming edges has to happen while the old
      // path's rows are still present, before any delete can remove them.
      for (const { oldPath, newPath } of renames) {
        await importIndexer.renameFileRelationships(repositoryId, oldPath, newPath);
      }
      for (const filePath of removedPaths) {
        await importIndexer.deleteFileRelationships(repositoryId, filePath);
      }
      for (const [filePath, imports] of importsByFile) {
        await importIndexer.indexFileRelationships(repositoryId, filePath, imports);
      }

      // 4. Record this chunk's receipt. The receipts are the run's single
      // completion count: finalize only once every chunk has committed —
      // indexQueue's concurrency:4 means the last-*enqueued* chunk isn't
      // reliably the last to *complete*.
      const { rows: progressRows } = await client.query(
        `UPDATE repositories
         SET completed_index_chunks = array_append(completed_index_chunks, $2)
         WHERE id = $1
         RETURNING cardinality(completed_index_chunks) AS chunks_done, index_chunks_total`,
        [repositoryId, chunkIndex],
      );
      const { chunks_done: chunksDone, index_chunks_total: chunksTotal } =
        progressRows[0];
      const isFinalChunk = chunksTotal != null && chunksDone >= chunksTotal;

      if (isFinalChunk) {
        // Every chunk of this run has committed, so the file list is now
        // complete: resolve the relative imports that pointed into a later
        // chunk and were recorded unresolved. Pure SQL plus in-memory path
        // matching — no network, safe inside the tx.
        const { pending, resolved } = await importIndexer.resolvePendingImports(repositoryId);
        console.log(
          `[Index] Pending imports for ${repositoryId}: resolved ${resolved} of ${pending}.`,
        );

        await client.query(
          `UPDATE repositories
           SET last_indexed_sha = $1,
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

      if (isFinalChunk) {
        // The actual completion point of a run — emitting here (not when the
        // chunks were enqueued) is what stops cache invalidation from firing
        // before the new data exists.
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
