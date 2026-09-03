import { Worker } from "bullmq";
import { createQueueConnection } from "./config/redis.js";
import { repositorySyncService } from "./services/repositorySync.service.js";
import { repositoryIndexer } from "./services/repositoryIndex.service.js";

/**
 * BullMQ Worker Entry Point
 * This file handles all background processing (Sync & Indexing)
 * It should be run as a separate process in production (e.g. `npm run worker`).
 */

console.log("Starting BullMQ Workers...");

// 1. Sync Worker: Pulls from RepositorySync queue
const syncWorker = new Worker(
  "RepositorySync",
  async (job) => {
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

// 2. Index Worker: Pulls from RepositoryIndex queue
const indexWorker = new Worker(
  "RepositoryIndex",
  async (job) => {
    const { repositoryId, latestSha, filesToIndex, isFinalChunk } = job.data;
    console.log(
      `[IndexWorker] Processing Chunk Job ${job.id} for Repo ${repositoryId}`,
    );
    await repositoryIndexer.processRepositoryUpdate(
      repositoryId,
      latestSha,
      filesToIndex,
      isFinalChunk,
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

// Graceful Shutdown
const gracefulShutdown = async () => {
  console.log("Shutting down workers gracefully...");
  await syncWorker.close();
  await indexWorker.close();
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
