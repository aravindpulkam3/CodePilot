import { pool } from "../config/db.js";
import * as githubService from "./github.service.js";
import { repositoryIndexer, FileChange } from "./repositoryIndex.service.js";

export class RepositorySyncService {
  /**
   * Checks if the repository is up-to-date. If not, it fetches the changes
   * and triggers the AST indexing pipeline.
   */
  public async syncRepository(clerkUserId: string, repositoryId: string) {
    // 1. Fetch current database state
    const { rows } = await pool.query(
      `SELECT name, owner, last_indexed_sha, indexing_status 
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

    const latestCommit = await githubService.getLatestCommit(
      clerkUserId,
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
        clerkUserId,
        repo.owner,
        repo.name,
        latestSha,
      );
    } else {
      // DELTA SYNC: Compare the old DB SHA with the new GitHub SHA.
      // Fetch ONLY the files that were added, modified, or deleted.
      console.log("code changed")
      filesToIndex = await githubService.getChangedFilesBetweenCommits(
        clerkUserId,
        repo.owner,
        repo.name,
        repo.last_indexed_sha,
        latestSha,
      );
    }

    console.log("files to be changed", filesToIndex.length);

    // 5. Hand off to the heavy Indexing pipeline
    // We do NOT await this here if this is triggered by a webhook,
    // to prevent timeout. But for manual syncs, awaiting is fine.
    await repositoryIndexer.processRepositoryUpdate(
      repositoryId,
      latestSha,
      filesToIndex,
    );

    return {
      status: "indexed",
      new_sha: latestSha,
      files_processed: filesToIndex.length,
    };
  }
}

export const repositorySyncService = new RepositorySyncService();
