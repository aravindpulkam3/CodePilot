import { Worker } from "bullmq";
import { createQueueConnection } from "./config/redis.js";
import { repositorySyncService } from "./features/repository/repositorySync.service.js";
import { repositoryIndexer } from "./features/repository/repositoryIndex.service.js";
import { pool } from "./config/db.js";
import { safeErrorDetails } from "./shared/utils/safeErrorDetails.js";

/**
 * BullMQ Worker Entry Point
 * This file handles all background processing (Sync & Indexing)
 * It should be run as a separate process in production (e.g. `npm run worker`).
 */

console.log("Starting BullMQ Workers...");

// Durable jobs are not discarded just because the worker was offline.
// Repository run tokens fence superseded jobs instead of an age cutoff.

// 1. Sync Worker: Pulls from RepositorySync queue
const syncWorker = new Worker(
  "RepositorySync",
  async (job) => {
    const { clerkUserId, repositoryId } = job.data;
    console.log(
      `[SyncWorker] Processing Job ${job.id} for Repo ${repositoryId}`,
    );
    await repositorySyncService.processSyncJob(clerkUserId, repositoryId, job.id!);
  },
  {
    connection: createQueueConnection(),
    concurrency: 2, // Process up to 2 syncs concurrently
  },
);

syncWorker.on("completed", (job) => {
  console.log(`[SyncWorker] Completed Job ${job.id}`);
});

syncWorker.on("failed", async (job, err) => {
  console.error(`[SyncWorker] Failed job ${job?.id}:`, safeErrorDetails(err));
  if (!job) return;
  try {
    if (await job.getState() !== "failed") return;
    await pool.query(
      "UPDATE repositories SET indexing_status = 'FAILED' WHERE id = $1 AND indexing_run_id = $2 AND indexing_status IN ('SYNCING', 'INDEXING')",
      [job.data.repositoryId, job.id],
    );
  } catch (statusError) {
    console.error("[SyncWorker] Could not record terminal failure:", safeErrorDetails(statusError));
  }
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
    const { repositoryId, latestSha, filesToIndex, runId, chunkIndex } = job.data;
    // Pre-upgrade jobs have no fence/receipt identity. Migration makes their repos retryable.
    if (!runId || !Number.isInteger(chunkIndex)) return { status: "skipped_legacy" };
    console.log(
      `[IndexWorker] Processing Chunk Job ${job.id} for Repo ${repositoryId}`,
    );
    await repositoryIndexer.processRepositoryUpdate(
      repositoryId,
      latestSha,
      filesToIndex,
      runId,
      chunkIndex,
    );
  },
  {
    connection: createQueueConnection(),
    concurrency: 4, // AST parsing + embedding batches parallelize safely; no LLM calls in indexing
  },
);

indexWorker.on("completed", (job) => {
  console.log(`[IndexWorker] Completed Job ${job.id}`);
});

indexWorker.on("failed", async (job, err) => {
  console.error(
    `[IndexWorker] Failed Job ${job?.id} for repo ${job?.data.repositoryId}:`,
    safeErrorDetails(err),
  );
  if (!job) return;
  try {
    // BullMQ also emits failed when scheduling a retry. Leave those jobs INDEXING.
    if ((await job.getState()) !== "failed") return;
    await pool.query(
      "UPDATE repositories SET indexing_status = 'FAILED' WHERE id = $1 AND indexing_run_id = $2 AND indexing_status = 'INDEXING'",
      [job.data.repositoryId, job.data.runId],
    );
  } catch (statusError) {
    // The original failure remains on the BullMQ job even if this update fails.
    console.error(
      `[IndexWorker] Could not record failure for job ${job.id}, repo ${job.data.repositoryId}:`,
      safeErrorDetails(statusError),
    );
  }
});

indexWorker.on("error", (err) => {
  console.error("[IndexWorker] Worker-level error:", err);
});

indexWorker.on("ready", () => {
  console.log("[IndexWorker] Connected to Redis and ready for jobs.");
});

// Graceful Shutdown
const gracefulShutdown = async () => {
  console.log("Shutting down workers gracefully...");
  await syncWorker.close();
  await indexWorker.close();
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
