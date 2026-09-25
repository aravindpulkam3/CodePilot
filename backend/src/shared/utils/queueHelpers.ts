import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";

/** BullMQ simple deduplication is atomic and releases its key on completion/failure. */
export async function enqueueWithDedup<T extends Record<string, unknown>>(
  queue: Queue, deduplicationId: string, jobName: string, data: T,
): Promise<{ status: "queued" | "already_queued"; jobId: string }> {
  const jobId = randomUUID();
  const job = await queue.add(jobName, data, { jobId, deduplication: { id: deduplicationId } });
  return { status: job.id === jobId ? "queued" : "already_queued", jobId: job.id! };
}
