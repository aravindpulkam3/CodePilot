import type { Queue } from "bullmq";

/**
 * Enqueues a job under a deterministic jobId, safely.
 *
 * BullMQ dedupes on jobId for as long as the job record exists in Redis —
 * including after it's completed or failed (removeOnComplete/removeOnFail
 * keep it around for a while). Queue.add() with a jobId that already exists
 * just returns the existing (possibly long-since-terminal) job instead of
 * creating new work — silently, no error. Left unhandled, that means a
 * repo could be synced/summarized exactly once: every later call looks
 * like it succeeded but never actually queues anything new.
 *
 * This removes a stale *terminal* job before re-adding, and skips
 * re-queuing only when a job for the same id is genuinely still in flight
 * (active/waiting/delayed) — which is the real anti-duplicate-concurrent-
 * work guard the deterministic id was meant to provide in the first place.
 *
 * Used by both repositorySync.service.ts#enqueueSync and
 * repositorySummarize.service.ts#enqueueSummarize so this fix lives in one
 * place instead of being hand-copied per queue.
 */
export async function enqueueWithDedup<T extends Record<string, unknown>>(
  queue: Queue,
  jobId: string,
  jobName: string,
  data: T,
): Promise<{ status: "queued" | "already_queued"; jobId: string }> {
  const existing = await queue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    console.log(`[Queue:${queue.name}] Found existing job ${jobId} in state "${state}".`);

    if (state === "completed" || state === "failed" || state === "unknown") {
      await existing.remove();
      console.log(`[Queue:${queue.name}] Removed stale ${state} job ${jobId} so a fresh one can be queued.`);
    } else {
      console.log(`[Queue:${queue.name}] Job ${jobId} is already ${state}; not re-queuing.`);
      return { status: "already_queued", jobId: existing.id! };
    }
  }

  const job = await queue.add(jobName, data, { jobId });
  console.log(`[Queue:${queue.name}] Queued job ${job.id}.`);
  return { status: "queued", jobId: job.id! };
}
