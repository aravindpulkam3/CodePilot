import { cacheRedisClient, coordinationRedisClient } from "../config/redis.js";

/**
 * High-speed generic cache wrapper with graceful degradation.
 * If Redis is down, it logs a warning and directly returns the fetcher result (Postgres fallback).
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  try {
    const cached = await cacheRedisClient.get(key);
    if (cached) {
      console.log(`[Cache] HIT: ${key}`);
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    console.warn(`[Cache Error] Failed to read key ${key}, falling back to source.`, error);
  }

  console.log(`[Cache] MISS: ${key} (Fetching from source)`);
  // Cache miss or Redis failure
  const data = await fetcher();

  try {
    if (data !== undefined && data !== null) {
      await cacheRedisClient.setex(key, ttlSeconds, JSON.stringify(data));
    }
  } catch (error) {
    console.warn(`[Cache Error] Failed to write key ${key}.`, error);
  }

  return data;
}

export async function getCache<T>(key: string): Promise<T | null> {
  try {
    const cached = await cacheRedisClient.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (error) {
    console.warn(`[Cache Error] Failed to read key ${key}.`, error);
  }
  return null;
}

export async function setCache<T>(key: string, ttlSeconds: number, data: T): Promise<void> {
  try {
    if (data !== undefined && data !== null) {
      await cacheRedisClient.setex(key, ttlSeconds, JSON.stringify(data));
    }
  } catch (error) {
    console.warn(`[Cache Error] Failed to write key ${key}.`, error);
  }
}

export async function invalidateCacheKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await cacheRedisClient.del(...keys);
  } catch (error) {
    console.warn(`[Cache Error] Failed to invalidate keys:`, error);
  }
}

/**
 * Safe pattern-based invalidation using SCAN.
 * NEVER use `KEYS *` in production as it blocks the Redis event loop.
 */
export async function invalidatePattern(pattern: string): Promise<void> {
  try {
    let cursor = "0";
    do {
      const result = await cacheRedisClient.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = result[0];
      const keys = result[1];
      if (keys.length > 0) {
        await cacheRedisClient.del(...keys);
      }
    } while (cursor !== "0");
  } catch (error) {
    console.warn(`[Cache Error] Failed to invalidate pattern ${pattern}:`, error);
  }
}

/**
 * Stampede Protection: Distributed Lock
 * Uses the coordination instance to ensure the lock isn't evicted under cache memory pressure.
 * 
 * TTL must be longer than the worst-case execution time of `workFn`.
 */
export async function withLock<T>(
  lockKey: string,
  ttlSeconds: number,
  workFn: () => Promise<T>
): Promise<T> {
  const acquired = await coordinationRedisClient.set(lockKey, "LOCKED", "EX", ttlSeconds, "NX");
  
  if (!acquired) {
    // In a real robust system, we would poll here. For now, throw a fast failure.
    throw new Error(`RESOURCE_LOCKED: Cannot acquire lock for ${lockKey}`);
  }

  try {
    return await workFn();
  } finally {
    // Release the lock
    await coordinationRedisClient.del(lockKey);
  }
}

