import { pool } from "../config/db.js";
import * as githubService from "./github.service.js";
import { embedder } from "./embedding.service.js";
import { ollamaService } from "./llm.service.js";
import { runSummarizationPipeline, updateSummariesIncrementally } from "./summaryPipeline.service.js";
import { PgSummaryStore } from "../utils/pgSummaryStore.js";
import { MemorySummaryStore } from "../utils/transactionBuffer.js";
import { summarizeQueue } from "../config/queues.js";
import { enqueueWithDedup } from "../utils/queueHelpers.js";
import { FileChange } from "./repositoryIndex.service.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { docSummaryLog, docPreview } from "../utils/readmeDebugLog.js";

/**
 * Phase 2 — background LLM summarization (Ollama, strictly sequential —
 * summarizeWorker runs at concurrency:1, globally, across every repo).
 *
 * This is entirely decoupled from Phase 1 (SEARCHABLE). A repo is usable
 * for Q&A/Review the moment SEARCHABLE is stamped; this service only ever
 * moves a repo from SEARCHABLE to READY, in the background, and is the
 * SOLE place indexing_status is ever set to 'READY'.
 */
export class RepositorySummarizeService {
  /**
   * Enqueues a summarize job targeting a specific revision. jobId is
   * intentionally keyed by repositoryId alone (no sha) — see the plan's
   * §2 "Why jobId = summarize-${repositoryId} still works": a second sync
   * landing mid-summarize can't create a duplicate pending job, and the
   * run-time staleness check (step 2) plus the self-recheck convergence
   * check (step 6) together guarantee the repo still converges on its
   * latest revision regardless.
   */
  public async enqueueSummarize(repositoryId: string, targetSha: string) {
    return enqueueWithDedup(summarizeQueue, `summarize-${repositoryId}`, "summarizeRepo", {
      repositoryId,
      targetSha,
    });
  }

  public async processSummarizeJob(repositoryId: string, targetSha: string) {
    console.log(`[Summarize] processSummarizeJob started for repo ${repositoryId}, target ${targetSha}.`);

    // 1. Current state
    const { rows } = await pool.query(
      `SELECT r.name, r.owner, r.source_type, r.last_indexed_sha, r.last_summarized_sha, au.clerk_id
       FROM repositories r JOIN app_users au ON au.id = r.user_id
       WHERE r.id = $1`,
      [repositoryId],
    );
    if (rows.length === 0) throw new Error("Repository not found");
    const repo = rows[0];

    // 2. Stale-job check — the repo already moved past targetSha before this
    // job even started (it sat behind other repos in the concurrency:1
    // queue). Don't touch indexing_status; just fall through to the
    // convergence check at the end.
    if (repo.last_indexed_sha !== targetSha) {
      console.log(
        `[Summarize] Stale job for ${repo.name} — target was ${targetSha}, repo is now at ${repo.last_indexed_sha}. Skipping summarization, will reconverge.`,
      );
      // NOT enqueueSummarize'd here: this job is still BullMQ-"active"
      // under jobId summarize-${repositoryId}, so a self-triggered enqueue
      // would just hit the dedup guard and no-op. worker.ts's "completed"
      // handler calls reconverge() once this job has actually settled.
      return { status: "stale_skipped" };
    }

    // 3. Already caught up (duplicate/retry) — no-op.
    if (repo.last_summarized_sha === targetSha) {
      console.log(`[Summarize] ${repo.name} already summarized at ${targetSha}. No-op.`);
      return { status: "already_summarized" };
    }

    let token: string | undefined = undefined;
    if (repo.source_type === "connected") {
      try {
        token = await githubService.getGitHubAccessToken(repo.clerk_id);
      } catch (err) {
        console.warn(`[Summarize] Could not get token for connected repo ${repo.name}`, err);
      }
    }

    await pool.query(
      `UPDATE repositories SET indexing_status = 'SUMMARIZING', last_summary_error = NULL WHERE id = $1`,
      [repositoryId],
    );

    const realStore = new PgSummaryStore(pool);
    const memStore = new MemorySummaryStore(realStore);

    try {
      // README for THIS revision, not HEAD. Pinning to targetSha is what
      // keeps a summary from mixing newer prose with older code — and since
      // the summary's content hash folds in hash(readme), a mismatched README
      // would be baked into a hash that then looks "current" next run.
      //
      // This THROWS on a transient fetch failure rather than falling back to
      // null: null means "this repo genuinely has no README", and treating a
      // network blip as that would (a) produce a summary wrongly claiming no
      // README exists and (b) poison the hash with hash(""), so the next run
      // would consider that wrong summary up to date and skip regenerating
      // it. Deliberately inside this try, so the catch below reverts
      // SUMMARIZING -> SEARCHABLE instead of stranding the repo mid-status.
      docSummaryLog(
        `Fetching canonical README for ${repo.owner}/${repo.name} pinned at targetSha=${targetSha} ` +
          `(NOT HEAD — a summary must describe the revision it is generated for).`,
      );

      const readme = await githubService.fetchCanonicalReadme(
        token,
        repo.owner,
        repo.name,
        targetSha,
      );

      if (readme) {
        docSummaryLog(
          `README fetched for ${repo.name}@${targetSha}: ${readme.length} chars :: ${docPreview(readme)}`,
        );
      } else {
        docSummaryLog(
          `No README found for ${repo.name}@${targetSha} (GitHub returned 404 — genuinely absent, not a fetch failure).`,
        );
      }

      // 4. Diff last_summarized_sha -> targetSha. This range can be wider
      // than any single sync's diff if summarization has been lagging
      // behind a burst of fast pushes — that's expected and handled here,
      // not by any Phase-1 shortcut.
      if (!repo.last_summarized_sha) {
        console.log(`[Summarize] First-ever summarization for ${repo.name} — fetching full tree at ${targetSha}.`);
        const allFiles = await githubService.fetchAllRepositoryFiles(token, repo.owner, repo.name, targetSha);
        const files = allFiles
          .filter((f) => f.status !== "removed" && f.content !== null)
          .map((f) => ({ path: f.path, source: f.content! }));

        docSummaryLog(
          `Passing README into runSummarizationPipeline (full) for ${repo.name}: ` +
            `${readme ? `${readme.length} chars` : "null"}. It feeds generateRepositorySummary's prompt ` +
            `and the repository node's content hash — so a README change alone regenerates that node.`,
        );

        await runSummarizationPipeline(
          { repositoryId, files, readme, packageMetadata: null },
          {
            llm: ollamaService,
            embeddings: embedder,
            store: memStore,
            useLLMModuleRefinement: false,
          },
        );
      } else {
        console.log(`[Summarize] Incremental summarization for ${repo.name}: ${repo.last_summarized_sha} -> ${targetSha}.`);
        const changedFiles: FileChange[] = await githubService.getChangedFilesBetweenCommits(
          token, repo.owner, repo.name, repo.last_summarized_sha, targetSha,
        );

        // Note: `readme` is fetched unconditionally above, NOT taken from
        // changedFiles. If the README didn't change in this diff range it
        // still has to be supplied, or hash(readme) would flip to hash("")
        // and regenerate the repository summary without it.
        docSummaryLog(
          `Passing README into updateSummariesIncrementally for ${repo.name}: ` +
            `${readme ? `${readme.length} chars` : "null"}. README.md ${
              changedFiles.some((f) => /^readme(\.|$)/i.test(f.path)) ? "IS" : "is NOT"
            } in this diff range — supplied either way, since omitting it would ` +
            `flip hash(readme) to hash("") and drop it from the repository summary.`,
        );

        await updateSummariesIncrementally(
          { repositoryId, changedFiles, readme, packageMetadata: null },
          {
            llm: ollamaService,
            embeddings: embedder,
            store: memStore,
          },
        );
      }
    } catch (error) {
      console.error(`[Summarize] Summarization failed for ${repo.name}:`, error);
      // Revert SUMMARIZING back to SEARCHABLE — a failed attempt must not
      // leave the repo permanently reporting "summarizing" once BullMQ
      // exhausts its retries. The CASE guard only reverts if still
      // SUMMARIZING (never stomps a newer sync's SYNCING/INDEXING if one
      // raced in while this was running); the last_indexed_sha check skips
      // the write entirely if the repo has already moved on.
      await pool.query(
        `UPDATE repositories
         SET last_summary_error = $2,
             indexing_status = CASE WHEN indexing_status = 'SUMMARIZING' THEN 'SEARCHABLE' ELSE indexing_status END
         WHERE id = $1 AND last_indexed_sha = $3`,
        [repositoryId, error instanceof Error ? error.message : String(error), targetSha],
      );
      // Searchability is untouched — Q&A/Review keep working. worker.ts's
      // "failed" handler calls reconverge() once this job has settled.
      throw error;
    }

    // 5. PRIMARY PROTECTION — the only place indexing_status is ever set to
    // READY. Guarded, transactional, holds a row lock across the recheck.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: recheck } = await client.query(
        `SELECT last_indexed_sha FROM repositories WHERE id = $1 FOR UPDATE`,
        [repositoryId],
      );

      if (recheck[0]?.last_indexed_sha !== targetSha || !targetSha) {
        await client.query("ROLLBACK");
        console.warn(
          `[Summarize] ${repo.name} advanced during summarization of ${targetSha} (now ${recheck[0]?.last_indexed_sha}) — discarding, not marking READY.`,
        );
      } else {
        const realTxStore = new PgSummaryStore(client);
        for (const del of memStore.pendingDeletes.values()) {
          await realTxStore.delete(del.repositoryId, del.nodeType, del.nodeKey);
        }
        for (const upsert of memStore.pendingUpserts.values()) {
          await realTxStore.upsert(upsert);
        }

        await client.query(
          `UPDATE repositories SET last_summarized_sha = $2, indexing_status = 'READY'
           WHERE id = $1 AND last_indexed_sha = $2 AND searchable_at IS NOT NULL`,
          [repositoryId, targetSha],
        );
        await client.query("COMMIT");
        console.log(`[Summarize] ${repo.name} marked READY at ${targetSha}.`);
      }
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`[Summarize] Error persisting summaries for ${repo.name}:`, error);
      await pool.query(
        `UPDATE repositories
         SET last_summary_error = $2,
             indexing_status = CASE WHEN indexing_status = 'SUMMARIZING' THEN 'SEARCHABLE' ELSE indexing_status END
         WHERE id = $1 AND last_indexed_sha = $3`,
        [repositoryId, error instanceof Error ? error.message : String(error), targetSha],
      );
      client.release();
      throw error;
    }
    client.release();

    return { status: "done" };
  }

  /**
   * FALLBACK convergence check — called from worker.ts's "completed"/
   * "failed" handlers, AFTER this job has settled (so a self-triggered
   * enqueueSummarize isn't blocked by its own still-active job record).
   * Ensures the repo eventually reaches READY for whatever its latest
   * revision turns out to be, even after any number of supersessions.
   * Cannot itself cause a wrong READY (only step 5's transaction writes
   * that); at worst a missed call here just leaves the repo at SEARCHABLE
   * instead of READY, never the reverse.
   */
  public async reconverge(repositoryId: string) {
    const { rows } = await pool.query(
      `SELECT last_indexed_sha, last_summarized_sha FROM repositories WHERE id = $1`,
      [repositoryId],
    );
    const repo = rows[0];
    if (repo?.last_indexed_sha && repo.last_indexed_sha !== repo.last_summarized_sha) {
      console.log(`[Summarize] Reconverging ${repositoryId} toward ${repo.last_indexed_sha}.`);
      await this.enqueueSummarize(repositoryId, repo.last_indexed_sha);
    }
  }
}

export const repositorySummarizeService = new RepositorySummarizeService();
