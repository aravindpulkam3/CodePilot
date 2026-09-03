import { pool } from "../config/db.js";
import * as githubService from "./github.service.js";
import { repositoryIndexer, FileChange } from "./repositoryIndex.service.js";
import { syncQueue, indexQueue } from "../config/queues.js";
import { appEvents, EVENT_TYPES } from "../events/eventEmitter.js";

export class RepositorySyncService {
  /**
   * Enqueues a sync job. Returns immediately.
   */
  public async enqueueSync(clerkUserId: string, repositoryId: string) {
    // Deterministic job ID prevents the same repo from being queued multiple times simultaneously
    const job = await syncQueue.add(
      "syncRepo", 
      { clerkUserId, repositoryId },
      { jobId: `sync-${repositoryId}` }
    );
    return { status: "queued", jobId: job.id };
  }

  /**
   * The actual heavy lifting executed by the BullMQ worker.
   */
  public async processSyncJob(clerkUserId: string, repositoryId: string) {
    // 1. Fetch current database state
    const { rows } = await pool.query(
      `SELECT name, owner, last_indexed_sha, indexing_status, source_type, user_id
             FROM repositories WHERE id = $1`,
      [repositoryId],
    );

    console.log("came to sync");

    if (rows.length === 0) throw new Error("Repository not found");
    const repo = rows[0];

    // Prevent concurrent indexing jobs for the same repo
    if (repo.indexing_status === "INDEXING") {
      console.log(
        `Repository ${repo.name} is already currently indexing. Skipping trigger.`,
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
        `Repository ${repo.name} is up to date (SHA: ${latestSha}). No indexing needed.`,
      );
      return { status: "up_to_date", sha: latestSha };
    }

    console.log(
      `Updating ${repo.name} from ${repo.last_indexed_sha || "Nothing"} to ${latestSha}...`,
    );

    // 4. Fetch the actual file contents that need to be indexed
    let filesToIndex: FileChange[] = [];

    if (!repo.last_indexed_sha) {
      // INITIAL SYNC: The database has no SHA. We must fetch the entire repository tree.
      console.log("[INITIAL SYNC]:fetching all files");
      filesToIndex = await githubService.fetchAllRepositoryFiles(
        token,
        repo.owner,
        repo.name,
        latestSha,
      );
    } else {
      // DELTA SYNC: Compare the old DB SHA with the new GitHub SHA.
      // Fetch ONLY the files that were added, modified, or deleted.
      console.log("code changed")
      filesToIndex = await githubService.getChangedFilesBetweenCommits(
        token,
        repo.owner,
        repo.name,
        repo.last_indexed_sha,
        latestSha,
      );
    }

    console.log("files to be changed", filesToIndex.length);

    // 5. Hand off to the heavy Indexing pipeline by enqueuing chunks
    const CHUNK_SIZE = 50;
    for (let i = 0; i < filesToIndex.length; i += CHUNK_SIZE) {
      const chunk = filesToIndex.slice(i, i + CHUNK_SIZE);
      await indexQueue.add("indexRepoChunk", {
        repositoryId,
        latestSha,
        filesToIndex: chunk,
        isFinalChunk: i + CHUNK_SIZE >= filesToIndex.length
      });
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
