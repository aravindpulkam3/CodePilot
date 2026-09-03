import { Request, Response, NextFunction } from "express";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { coordinationRedisClient } from "../config/redis.js";

/**
 * Sliding window rate limiters for expensive operations (LLM / Sync).
 * Uses the Coordination Redis instance (noeviction) to ensure limits aren't lost to cache pressure.
 */

// Global options factory
const createLimiter = (keyPrefix: string, points: number, duration: number) => {
  return new RateLimiterRedis({
    storeClient: coordinationRedisClient,
    keyPrefix,
    points,      // Number of requests
    duration,    // Per duration in seconds
    blockDuration: 60, // Block for 60 seconds if exceeded
  });
};

// 1. Sync Rate Limiter (e.g. 5 syncs per user per 10 minutes)
const syncLimiter = createLimiter("rl:sync", 5, 600);

// 2. Chat Rate Limiter (e.g. 20 messages per user per 5 minutes)
const chatLimiter = createLimiter("rl:chat", 20, 300);

// 3. Review Rate Limiter (e.g. 10 reviews per user per hour)
const reviewLimiter = createLimiter("rl:review", 10, 3600);

/**
 * Middleware factory for applying rate limits.
 */
export const rateLimit = (type: "sync" | "chat" | "review") => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // If no dbUser is attached, we can't rate limit by user (e.g. unauth route, but these should be authed)
    const userId = req.dbUser?.id || req.ip || "unknown";
    
    let limiter: RateLimiterRedis;
    switch (type) {
      case "sync": limiter = syncLimiter; break;
      case "chat": limiter = chatLimiter; break;
      case "review": limiter = reviewLimiter; break;
    }

    try {
      await limiter.consume(userId, 1);
      next();
    } catch (rejRes: any) {
      // It's a rejection, meaning rate limit exceeded
      res.status(429).json({ 
        error: "Too Many Requests", 
        retryAfterMs: rejRes.msBeforeNext 
      });
    }
  };
};
