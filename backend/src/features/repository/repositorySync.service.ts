import { pool } from "../../config/db.js";
import * as githubService from "../../infrastructure/github/github.service.js";
import { isIndexableFile, type FileChange } from "./repositoryIndex.service.js";
import { syncQueue, indexQueue } from "../../config/queues.js";
import { appEvents, EVENT_TYPES } from "../../shared/events/eventEmitter.js";
import { enqueueWithDedup } from "../../shared/utils/queueHelpers.js";

export class RepositorySyncService {
  public async enqueueSync(clerkUserId: string, repositoryId: string) {
    const { rows } = await pool.query(
      `SELECT 1 FROM repositories r JOIN app_users u ON u.id = r.user_id
       WHERE r.id = $1 AND u.clerk_id = $2`, [repositoryId, clerkUserId],
    );
    if (!rows.length) throw new Error("RESOURCE_NOT_FOUND");
    return enqueueWithDedup(syncQueue, `sync-${repositoryId}`, "syncRepo", { clerkUserId, repositoryId });
  }

  public async processSyncJob(clerkUserId: string, repositoryId: string, runId: string) {
    // Claim before any network work. Two different runs cannot claim an in-flight repo.
    // A retry resumes its own run without clearing committed chunk receipts.
    const { rows } = await pool.query(
      `UPDATE repositories r SET
         indexing_target_sha = CASE WHEN indexing_run_id = $3 THEN indexing_target_sha ELSE NULL END,
         index_chunks_total = CASE WHEN indexing_run_id = $3 THEN index_chunks_total ELSE NULL END,
         completed_index_chunks = CASE WHEN indexing_run_id = $3 THEN completed_index_chunks ELSE '{}'::integer[] END,
         indexing_status = 'INDEXING',
         indexing_run_id = $3
       WHERE r.id = $1 AND EXISTS (SELECT 1 FROM app_users u WHERE u.id = r.user_id AND u.clerk_id = $2)
         AND ((indexing_run_id = $3 AND indexing_status = 'INDEXING')
           OR (indexing_status <> 'INDEXING' AND indexing_run_id IS DISTINCT FROM $3))
       RETURNING r.*`, [repositoryId, clerkUserId, runId],
    );
    if (!rows.length) return { status: "already_indexing_or_stale" };
    const repo = rows[0];
    let token: string | undefined;
    if (repo.source_type === "connected") {
      try { token = await githubService.getGitHubAccessToken(clerkUserId); }
      catch { console.warn(`[Sync] OAuth unavailable for repo ${repositoryId}; trying public access.`); }
    }
    const requestedSha = repo.indexing_target_sha ?? (await githubService.getLatestCommit(token, repo.owner, repo.name)).sha;
    const { rows: targets } = await pool.query(
      `UPDATE repositories SET indexing_target_sha = COALESCE(indexing_target_sha, $3)
       WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'INDEXING'
       RETURNING indexing_target_sha`, [repositoryId, runId, requestedSha],
    );
    if (!targets.length) return { status: "stale" };
    const latestSha = targets[0].indexing_target_sha;
    let lastIndexedSha: string | null = repo.last_indexed_sha;
    let filesToIndex: FileChange[] = [];
    if (lastIndexedSha && lastIndexedSha !== latestSha) {
      const delta = await githubService.getChangedFilesBetweenCommits(token, repo.owner, repo.name, lastIndexedSha, latestSha, isIndexableFile);
      if (delta) filesToIndex = delta;
      else {
        // The compare can't be applied as a delta (GitHub's 300-file cap, a
        // force-push, or a base that no longer resolves). Invalidate first, so
        // retrieval refuses before anything is cleared, then rebuild at the same
        // pinned target below. A resumed run goes straight to that path.
        console.warn(`[Sync] ${repo.owner}/${repo.name}: compare ${lastIndexedSha}...${latestSha} is not a usable delta; rebuilding.`);
        const { rowCount } = await pool.query(
          `UPDATE repositories SET last_indexed_sha = NULL
           WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'INDEXING' AND index_chunks_total IS NULL`,
          [repositoryId, runId],
        );
        if (!rowCount) return { status: "stale" };
        lastIndexedSha = null;
      }
    }
    if (!lastIndexedSha) {
      // A full index starts from an empty index: a run that failed after writing
      // may have left rows behind. Never once this run's chunk jobs exist.
      await pool.query(
        `WITH run AS (
           SELECT id FROM repositories
           WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'INDEXING' AND index_chunks_total IS NULL
           FOR UPDATE),
         cleared AS (DELETE FROM repository_embeddings WHERE repository_id IN (SELECT id FROM run))
         DELETE FROM repository_imports WHERE repository_id IN (SELECT id FROM run)`,
        [repositoryId, runId],
      );
      filesToIndex = await githubService.fetchAllRepositoryFiles(token, repo.owner, repo.name, latestSha, isIndexableFile);
    }
    // Stable chunk membership if a sync retries after only some jobs were enqueued.
    filesToIndex.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // index_chunks_total IS NULL: this run hasn't enqueued chunk jobs yet.
    if (!filesToIndex.length) {
      const result = await pool.query(
        `UPDATE repositories SET last_indexed_sha = $3, indexing_status = 'READY'
         WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'INDEXING' AND index_chunks_total IS NULL`,
        [repositoryId, runId, latestSha],
      );
      if (result.rowCount) appEvents.emit(EVENT_TYPES.REPOSITORY_SYNCED, { userId: repo.user_id, repositoryId });
      return { status: "up_to_date", sha: latestSha };
    }
    const CHUNK_SIZE = 50;
    const chunkCount = Math.ceil(filesToIndex.length / CHUNK_SIZE);
    await pool.query(
      `UPDATE repositories SET index_chunks_total = $3
       WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'INDEXING' AND index_chunks_total IS NULL`,
      [repositoryId, runId, chunkCount],
    );
    for (let i = 0; i < filesToIndex.length; i += CHUNK_SIZE) {
      const chunkIndex = i / CHUNK_SIZE;
      await indexQueue.add("indexRepoChunk", {
        repositoryId, latestSha, runId, chunkIndex, filesToIndex: filesToIndex.slice(i, i + CHUNK_SIZE),
      }, { jobId: `index-${runId}-${chunkIndex}` });
    }
    return { status: "indexed", new_sha: latestSha, files_processed: filesToIndex.length };
  }
}

export const repositorySyncService = new RepositorySyncService();
