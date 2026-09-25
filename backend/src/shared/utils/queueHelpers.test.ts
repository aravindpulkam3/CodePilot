import { test } from "node:test";
import assert from "node:assert/strict";
import type { Queue } from "bullmq";
import { enqueueWithDedup } from "./queueHelpers.js";

test("sync deduplication keeps an active job but permits later runs and other repositories", async () => {
  // Model BullMQ's atomic simple-deduplication contract; terminal records may remain.
  const active = new Map<string, string>();
  const jobs = new Set<string>();
  const queue = {
    async add(_name: string, _data: unknown, options: { jobId: string; deduplication: { id: string } }) {
      const key = options.deduplication.id;
      const id = active.get(key) ?? options.jobId;
      active.set(key, id);
      jobs.add(id);
      return { id };
    },
  } as unknown as Queue;
  const [first, duplicate, other] = await Promise.all([
    enqueueWithDedup(queue, "repo-a", "sync", {}),
    enqueueWithDedup(queue, "repo-a", "sync", {}),
    enqueueWithDedup(queue, "repo-b", "sync", {}),
  ]);
  assert.equal(duplicate.status, "already_queued");
  assert.equal(first.jobId, duplicate.jobId);
  assert.notEqual(first.jobId, other.jobId);
  active.delete("repo-a"); // BullMQ releases the key when the job finishes.
  const later = await enqueueWithDedup(queue, "repo-a", "sync", {});
  assert.equal(later.status, "queued");
  assert.notEqual(first.jobId, later.jobId);
  assert.equal(jobs.size, 3);
});
