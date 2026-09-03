import { EventEmitter } from "events";
import { invalidatePattern } from "../utils/cache.js";

class AppEventEmitter extends EventEmitter {}

export const appEvents = new AppEventEmitter();

// Define Event Types
export const EVENT_TYPES = {
  REPOSITORY_SYNCED: "repository.synced",
  REPOSITORY_INDEXED: "repository.indexed",
  REPOSITORY_ADDED: "repository.added",
  REPOSITORY_REMOVED: "repository.removed",
  PR_REVIEW_COMPLETED: "pr_review.completed",
};

/**
 * Cache Invalidation Subscriptions
 * Centralizes cache-key knowledge away from write-path services.
 */
appEvents.on(EVENT_TYPES.REPOSITORY_ADDED, async ({ userId }) => {
  await invalidatePattern(`user:${userId}:repos*`);
  await invalidatePattern(`user:${userId}:dashboard*`);
});

appEvents.on(EVENT_TYPES.REPOSITORY_REMOVED, async ({ userId }) => {
  await invalidatePattern(`user:${userId}:repos*`);
  await invalidatePattern(`user:${userId}:dashboard*`);
});

appEvents.on(EVENT_TYPES.REPOSITORY_SYNCED, async ({ userId, repositoryId }) => {
  await invalidatePattern(`user:${userId}:repos*`);
  await invalidatePattern(`repo:${repositoryId}:details*`);
  await invalidatePattern(`user:${userId}:dashboard*`);
});

appEvents.on(EVENT_TYPES.REPOSITORY_INDEXED, async ({ userId, repositoryId }) => {
  await invalidatePattern(`user:${userId}:repos*`);
  await invalidatePattern(`repo:${repositoryId}:details*`);
  await invalidatePattern(`user:${userId}:dashboard*`);
});

appEvents.on(EVENT_TYPES.PR_REVIEW_COMPLETED, async ({ userId, repositoryId }) => {
  await invalidatePattern(`user:${userId}:dashboard:pending-prs*`);
  await invalidatePattern(`user:${userId}:dashboard:recent-work*`);
  await invalidatePattern(`user:${userId}:dashboard:activity*`);
});
