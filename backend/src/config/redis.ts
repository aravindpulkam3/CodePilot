import { Redis, RedisOptions } from "ioredis";

const CACHE_URL = process.env.REDIS_CACHE_URL || "redis://localhost:6379";
const QUEUE_URL = process.env.REDIS_QUEUE_URL || "redis://localhost:6380";

/**
 * CACHE REDIS CLIENT
 * Used for high-speed, volatile caching.
 * Expects the target Redis instance to have `maxmemory-policy allkeys-lru` or similar.
 */
export const cacheRedisClient = new Redis(CACHE_URL, {
  enableReadyCheck: false,
  maxRetriesPerRequest: 3, // We don't want cache queries hanging forever if Redis is down
});

cacheRedisClient.on("error", (err: any) => {
  console.warn("Cache Redis error (graceful degradation active):", err.message);
});

/**
 * QUEUE REDIS CLIENT CONFIGURATION
 * BullMQ requires `maxRetriesPerRequest: null`. 
 * This instance MUST have `maxmemory-policy noeviction`.
 */
const queueRedisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// We create separate connections for BullMQ workers and queues to avoid blocking issues
export const createQueueConnection = () => new Redis(QUEUE_URL, queueRedisOptions);
export const queueConnection = createQueueConnection(); // For Queue instances which don't block

// For Rate Limiting and Locks (using the queue/coordination instance to prevent eviction of locks)
export const coordinationRedisClient = new Redis(QUEUE_URL, {
  enableReadyCheck: false,
});

coordinationRedisClient.on("error", (err: any) => {
  console.error("Coordination Redis error:", err.message);
});

queueConnection.on("error", (err: any) => {
  console.error("Queue Redis error:", err.message);
});

/**
 * Gracefully close all Redis connections.
 * Used during process teardown.
 */
export const closeRedisConnections = async () => {
  console.log("Closing Redis connections...");
  await Promise.all([
    cacheRedisClient.quit(),
    queueConnection.quit(),
    coordinationRedisClient.quit(),
  ]).catch((err) => console.error("Error closing Redis connections:", err));
};
