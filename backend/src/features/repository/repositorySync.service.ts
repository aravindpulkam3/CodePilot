import { pool } from "../../config/db.js";
import * as githubService from "../../infrastructure/github/github.service.js";
import type { FileChange } from "./repositoryIndex.service.js";
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
    // A retry resumes its own run without clearing committed chunk receipts/counters.
    const { rows } = await pool.query(
      `UPDATE repositories r SET
         indexing_target_sha = CASE WHEN indexing_run_id = $3 THEN indexing_target_sha ELSE NULL END,
         completed_index_chunks = CASE WHEN indexing_run_id = $3 THEN completed_index_chunks ELSE '{}'::integer[] END,
         indexing_status = CASE WHEN indexing_run_id = $3 THEN indexing_status ELSE 'SYNCING' END,
         indexing_run_id = $3
       WHERE r.id = $1 AND EXISTS (SELECT 1 FROM app_users u WHERE u.id = r.user_id AND u.clerk_id = $2)
         AND ((indexing_run_id = $3 AND indexing_status IN ('SYNCING', 'INDEXING'))
           OR (indexing_status NOT IN ('SYNCING', 'INDEXING') AND indexing_run_id IS DISTINCT FROM $3))
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
       WHERE id = $1 AND indexing_run_id = $2 AND indexing_status IN ('SYNCING', 'INDEXING')
       RETURNING indexing_target_sha`, [repositoryId, runId, requestedSha],
    );
    if (!targets.length) return { status: "stale" };
    const latestSha = targets[0].indexing_target_sha;
    let filesToIndex: FileChange[] = [];
    if (repo.last_indexed_sha !== latestSha) {
      filesToIndex = !repo.last_indexed_sha
        ? await githubService.fetchAllRepositoryFiles(token, repo.owner, repo.name, latestSha)
        : await githubService.getChangedFilesBetweenCommits(token, repo.owner, repo.name, repo.last_indexed_sha, latestSha);
    }
    // Stable chunk membership if a sync retries after only some jobs were enqueued.
    filesToIndex.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!filesToIndex.length) {
      const result = await pool.query(
        `UPDATE repositories SET last_indexed_sha = $3,
           searchable_at = COALESCE(searchable_at, NOW()), indexing_status = 'READY',
           index_chunks_total = 0, index_chunks_done = 0, index_files_total = 0, index_files_done = 0
         WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'SYNCING'`, [repositoryId, runId, latestSha],
      );
      if (result.rowCount) appEvents.emit(EVENT_TYPES.REPOSITORY_SYNCED, { userId: repo.user_id, repositoryId });
      return { status: "up_to_date", sha: latestSha };
    }
    const CHUNK_SIZE = 50;
    const chunkCount = Math.ceil(filesToIndex.length / CHUNK_SIZE);
    await pool.query(
      `UPDATE repositories SET index_chunks_total = $3, index_chunks_done = 0,
         index_files_total = $4, index_files_done = 0, indexing_status = 'INDEXING'
       WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'SYNCING'`,
      [repositoryId, runId, chunkCount, filesToIndex.length],
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
