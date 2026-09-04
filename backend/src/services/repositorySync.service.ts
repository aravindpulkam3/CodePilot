import { pool } from "../config/db.js";
import * as githubService from "./github.service.js";
import { repositoryIndexer, FileChange } from "./repositoryIndex.service.js";
import { syncQueue, indexQueue } from "../config/queues.js";
import { appEvents, EVENT_TYPES } from "../events/eventEmitter.js";
import { enqueueWithDedup } from "../utils/queueHelpers.js";
import { repositorySummarizeService } from "./repositorySummarize.service.js";

// Phase-1 in-flight states — a new sync must not start while one of these
// is true for the repo. SUMMARIZING is deliberately NOT included: a new
// sync is allowed to run while an older revision is still being
// summarized in the background (see repositorySummarize.service.ts's
// SHA-aware handling of that race).
const SYNC_IN_FLIGHT_STATUSES = new Set(["SYNCING", "INDEXING"]);

export class RepositorySyncService {
  /**
   * Enqueues a sync job. Returns immediately.
   */
  public async enqueueSync(clerkUserId: string, repositoryId: string) {
    return enqueueWithDedup(syncQueue, `sync-${repositoryId}`, "syncRepo", {
      clerkUserId,
      repositoryId,
    });
  }

  /**
   * The actual heavy lifting executed by the BullMQ worker.
   */
  public async processSyncJob(clerkUserId: string, repositoryId: string) {
    // 1. Fetch current database state
    console.log(`[Sync] processSyncJob started for repo ${repositoryId}.`);

    const { rows } = await pool.query(
      `SELECT name, owner, last_indexed_sha, last_summarized_sha, indexing_status, source_type, user_id
             FROM repositories WHERE id = $1`,
      [repositoryId],
    );

    if (rows.length === 0) throw new Error("Repository not found");
    const repo = rows[0];

    // Prevent concurrent Phase-1 runs for the same repo. Does NOT block on
    // SUMMARIZING — a new sync is allowed to start while an older revision
    // is still being summarized in the background; that race is handled
    // explicitly by repositorySummarize.service.ts's SHA-aware logic.
    if (SYNC_IN_FLIGHT_STATUSES.has(repo.indexing_status)) {
      console.log(
        `[Sync] Repository ${repo.name} already has Phase 1 in flight (${repo.indexing_status}). Skipping trigger.`,
      );
      return { status: "already_indexing" };
    }

    // Fetch token only if it's a connected repository
    let token: string | undefined = undefined;
    if (repo.source_type === "connected") {
      try {
        token = await githubService.getGitHubAccessToken(clerkUserId);
      } catch (err) {
        console.warn(`Could not get token for connected repo ${repo.name}`, err);
      }
    }

    const latestCommit = await githubService.getLatestCommit(
      token,
      repo.owner,
      repo.name,
    );
    const latestSha = latestCommit.sha;

    // 3. The Guard Check: Are we already up to date?
    if (repo.last_indexed_sha === latestSha) {
      console.log(
        `[Sync] Repository ${repo.name} is up to date (SHA: ${latestSha}). No indexing needed.`,
      );
      return { status: "up_to_date", sha: latestSha };
    }

    console.log(
      `[Sync] Updating ${repo.name} from ${repo.last_indexed_sha || "(never indexed)"} to ${latestSha}...`,
    );

    // Committed to indexing now — reflect that immediately so pollers see
    // real state rather than a stale prior status while GitHub is fetched.
    await pool.query(`UPDATE repositories SET indexing_status = 'SYNCING' WHERE id = $1`, [repositoryId]);

    // 4. Fetch the actual file contents that need to be indexed
    let filesToIndex: FileChange[] = [];

    if (!repo.last_indexed_sha) {
      // INITIAL SYNC: The database has no SHA. We must fetch the entire repository tree.
      console.log(`[Sync] Initial sync — fetching the full repository tree for ${repo.name}.`);
      filesToIndex = await githubService.fetchAllRepositoryFiles(
        token,
        repo.owner,
        repo.name,
        latestSha,
      );
    } else {
      // DELTA SYNC: Compare the old DB SHA with the new GitHub SHA.
      // Fetch ONLY the files that were added, modified, or deleted.
      console.log(`[Sync] Delta sync — diffing ${repo.last_indexed_sha} against ${latestSha}.`);
      filesToIndex = await githubService.getChangedFilesBetweenCommits(
        token,
        repo.owner,
        repo.name,
        repo.last_indexed_sha,
        latestSha,
      );
    }

    console.log(`[Sync] ${filesToIndex.length} file(s) to index for ${repo.name}.`);

    // 4a. Zero-file delta: nothing for Phase 1 to do THIS sync. This does
    // NOT mean summarization is caught up — Phase 2 diffs a different,
    // potentially wider range (last_summarized_sha -> latestSha, which can
    // span several prior syncs if summarization has been lagging). So this
    // only ever advances Phase-1 state directly; Phase 2's own job (§2 of
    // the plan) is the sole place that decides whether READY is warranted,
    // via its own diff — never assumed here from an empty single-sync diff.
    if (filesToIndex.length === 0) {
      const { rows: updated } = await pool.query(
        `UPDATE repositories
         SET last_indexed_sha = $2,
             searchable_at = COALESCE(searchable_at, NOW()),
             index_chunks_total = 0, index_chunks_done = 0,
             index_files_total = 0, index_files_done = 0,
             indexing_status = CASE WHEN last_summarized_sha = $2 THEN 'READY' ELSE 'SEARCHABLE' END
         WHERE id = $1
         RETURNING last_summarized_sha, indexing_status`,
        [repositoryId, latestSha],
      );
      const nowSummarizedSha = updated[0]?.last_summarized_sha;
      console.log(
        `[Sync] ${repo.name}: no files changed this sync, advanced to ${latestSha} directly (status=${updated[0]?.indexing_status}).`,
      );
      if (nowSummarizedSha !== latestSha) {
        await repositorySummarizeService.enqueueSummarize(repositoryId, latestSha);
      }
      appEvents.emit(EVENT_TYPES.REPOSITORY_SYNCED, { userId: repo.user_id, repositoryId });
      return { status: "searchable_no_changes", new_sha: latestSha };
    }

    // 5. Hand off to the heavy Indexing pipeline by enqueuing chunks
    const CHUNK_SIZE = 50;
    const chunkCount = Math.ceil(filesToIndex.length / CHUNK_SIZE);
    await pool.query(
      `UPDATE repositories
       SET index_chunks_total = $2, index_chunks_done = 0,
           index_files_total = $3, index_files_done = 0,
           indexing_status = 'INDEXING'
       WHERE id = $1`,
      [repositoryId, chunkCount, filesToIndex.length],
    );
    console.log(`[Sync] Enqueuing ${chunkCount} index chunk job(s) for ${repo.name}.`);
    for (let i = 0; i < filesToIndex.length; i += CHUNK_SIZE) {
      const chunk = filesToIndex.slice(i, i + CHUNK_SIZE);
      const isFinalChunk = i + CHUNK_SIZE >= filesToIndex.length;
      const indexJob = await indexQueue.add("indexRepoChunk", {
        repositoryId,
        latestSha,
        filesToIndex: chunk,
        // isFinalChunk is kept on the payload for logging only — the
        // actual SEARCHABLE-finalize decision uses the chunk-completion
        // counter (repositoryIndex.service.ts), not this flag, since
        // indexQueue's concurrency:4 means the last-enqueued chunk isn't
        // reliably the last to complete.
        isFinalChunk,
      });
      console.log(
        `[Sync] Queued index job ${indexJob.id} (${chunk.length} files, final=${isFinalChunk}).`,
      );
    }

    // Emit event that sync is done (but indexing might still be ongoing).
    // Cache keys are keyed by the internal app_users.id, not the Clerk id, so invalidation must use that.
    appEvents.emit(EVENT_TYPES.REPOSITORY_SYNCED, { userId: repo.user_id, repositoryId });

    return {
      status: "indexed",
      new_sha: latestSha,
      files_processed: filesToIndex.length,
    };
  }
}

export const repositorySyncService = new RepositorySyncService();
