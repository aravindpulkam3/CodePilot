import { Worker } from "bullmq";
import { createQueueConnection } from "./config/redis.js";
import { repositorySyncService } from "./services/repositorySync.service.js";
import { repositoryIndexer } from "./services/repositoryIndex.service.js";
import { repositorySummarizeService } from "./services/repositorySummarize.service.js";

/**
 * BullMQ Worker Entry Point
 * This file handles all background processing (Sync & Indexing)
 * It should be run as a separate process in production (e.g. `npm run worker`).
 */

console.log("Starting BullMQ Workers...");

// Jobs are durable by design — that's the point of a queue instead of doing
// this inline on the request (the worker can restart/be down without losing
// work). But a job queued while the worker was down has no natural upper
// bound on how long it waits; without this, restarting the worker after it's
// been off for a while fires every backlog request at once, including ones
// tied to a browser session nobody's looking at anymore. Anything older than
// this just gets skipped instead of silently running late.
const MAX_JOB_AGE_MS = 60 * 60 * 1000; // 1 hour

function isTooStale(job: { id?: string; timestamp: number }): boolean {
  const ageMs = Date.now() - job.timestamp;
  if (ageMs > MAX_JOB_AGE_MS) {
    console.warn(
      `[Worker] Skipping job ${job.id} — queued ${Math.round(ageMs / 60000)} min ago, older than the ${MAX_JOB_AGE_MS / 60000} min limit.`,
    );
    return true;
  }
  return false;
}

// 1. Sync Worker: Pulls from RepositorySync queue
const syncWorker = new Worker(
  "RepositorySync",
  async (job) => {
    if (isTooStale(job)) return { status: "skipped_stale" };

    const { clerkUserId, repositoryId } = job.data;
    console.log(
      `[SyncWorker] Processing Job ${job.id} for Repo ${repositoryId}`,
    );
    await repositorySyncService.processSyncJob(clerkUserId, repositoryId);
  },
  {
    connection: createQueueConnection(),
    concurrency: 2, // Process up to 2 syncs concurrently
  },
);

syncWorker.on("completed", (job) => {
  console.log(`[SyncWorker] Completed Job ${job.id}`);
});

syncWorker.on("failed", (job, err) => {
  console.error(`[SyncWorker] Failed Job ${job?.id}:`, err);
});

// Connection-level errors (bad Redis config, dropped connection, etc.) don't
// go through "failed" — without this handler they were silent, making a
// dead worker look identical to "no jobs queued."
syncWorker.on("error", (err) => {
  console.error("[SyncWorker] Worker-level error:", err);
});

syncWorker.on("ready", () => {
  console.log("[SyncWorker] Connected to Redis and ready for jobs.");
});

// 2. Index Worker: Pulls from RepositoryIndex queue
const indexWorker = new Worker(
  "RepositoryIndex",
  async (job) => {
    if (isTooStale(job)) return { status: "skipped_stale" };

    const { repositoryId, latestSha, filesToIndex } = job.data;
    console.log(
      `[IndexWorker] Processing Chunk Job ${job.id} for Repo ${repositoryId}`,
    );
    await repositoryIndexer.processRepositoryUpdate(
      repositoryId,
      latestSha,
      filesToIndex,
    );
  },
  {
    connection: createQueueConnection(),
    concurrency: 4, // Parsing ASTs / LLMs can be parallelized safely
  },
);

indexWorker.on("completed", (job) => {
  console.log(`[IndexWorker] Completed Job ${job.id}`);
});

indexWorker.on("failed", (job, err) => {
  console.error(`[IndexWorker] Failed Job ${job?.id}:`, err);
});

indexWorker.on("error", (err) => {
  console.error("[IndexWorker] Worker-level error:", err);
});

indexWorker.on("ready", () => {
  console.log("[IndexWorker] Connected to Redis and ready for jobs.");
});

// 3. Summarize Worker: Pulls from RepositorySummarize queue.
// concurrency: 1 is a hard requirement, not a tuning choice — there is
// exactly one local Ollama instance and summarization must stay strictly
// sequential across ALL repos, never just per-repo. Never raise this.
const summarizeWorker = new Worker(
  "RepositorySummarize",
  async (job) => {
    if (isTooStale(job)) return { status: "skipped_stale" };

    const { repositoryId, targetSha } = job.data;
    console.log(
      `[SummarizeWorker] Processing Job ${job.id} for Repo ${repositoryId} (target ${targetSha})`,
    );
    return await repositorySummarizeService.processSummarizeJob(repositoryId, targetSha);
  },
  {
    connection: createQueueConnection(),
    concurrency: 1,
  },
);

// The convergence re-check (plan §2 step 6) runs here, AFTER the job has
// settled — not inside processSummarizeJob itself, since a self-triggered
// enqueue while the job's own record is still "active" under the same
// deterministic jobId would just hit the dedup guard and no-op.
summarizeWorker.on("completed", async (job) => {
  console.log(`[SummarizeWorker] Completed Job ${job.id}`);
  const { repositoryId } = job.data;
  if (repositoryId) {
    try {
      await repositorySummarizeService.reconverge(repositoryId);
    } catch (err) {
      console.error(`[SummarizeWorker] Reconverge check failed for ${repositoryId}:`, err);
    }
  }
});

summarizeWorker.on("failed", async (job, err) => {
  console.error(`[SummarizeWorker] Failed Job ${job?.id}:`, err);
  const repositoryId = job?.data?.repositoryId;
  if (repositoryId) {
    try {
      await repositorySummarizeService.reconverge(repositoryId);
    } catch (e) {
      console.error(`[SummarizeWorker] Reconverge check failed for ${repositoryId}:`, e);
    }
  }
});

summarizeWorker.on("error", (err) => {
  console.error("[SummarizeWorker] Worker-level error:", err);
});

summarizeWorker.on("ready", () => {
  console.log("[SummarizeWorker] Connected to Redis and ready for jobs.");
});

// Graceful Shutdown
const gracefulShutdown = async () => {
  console.log("Shutting down workers gracefully...");
  await syncWorker.close();
  await indexWorker.close();
  await summarizeWorker.close();
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
