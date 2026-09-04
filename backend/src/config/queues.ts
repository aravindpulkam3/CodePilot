import { Queue } from "bullmq";
import { queueConnection } from "./redis.js";

/**
 * BullMQ Queues
 * Reusing the same IORedis connection tailored for queues.
 */

// 1. Sync Queue: Handles fetching GitHub changes and parsing ASTs
export const syncQueue = new Queue("RepositorySync", {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

// 2. Index Queue: Handles generating embeddings and pushing to pgvector
export const indexQueue = new Queue("RepositoryIndex", {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

// 3. Summarize Queue: Phase 2, sequential Ollama summarization toward READY
export const summarizeQueue = new Queue("RepositorySummarize", {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const queues = [syncQueue, indexQueue, summarizeQueue];

/**
 * Gracefully close all queues.
 */
export const closeQueues = async () => {
  console.log("Closing BullMQ queues...");
  await Promise.all(queues.map((q) => q.close())).catch((err) =>
    console.error("Error closing queues:", err)
  );
};
