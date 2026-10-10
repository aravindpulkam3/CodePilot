import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fetchPullRequestSnapshot, type PullRequestFile } from "./pullRequestSnapshot.js";
import { CodeReviewPromptBuilder } from "../../features/review/codeReviewPromptBuilder.js";
import { createRequestBudget } from "../llm/requestBudget.js";

const file = (i: number): PullRequestFile => ({ filename: `src/f${i}.ts`, status: "modified", additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-old${i}\n+new${i}` });
const metadata = (count: number, head = "head", base = "base") => ({ head: { sha: head }, base: { sha: base }, changed_files: count });

describe("PR acquisition", () => {
  for (const count of [30, 31, 100, 300]) {
    test(`fetches all ${count} files, including the last page in review preparation`, async () => {
      const files = Array.from({ length: count }, (_, i) => file(i));
      const pages: number[] = [];
      const snapshot = await fetchPullRequestSnapshot(async () => metadata(count), async (page) => {
        pages.push(page);
        return { files: files.slice((page - 1) * 100, page * 100), hasNext: page * 100 < count };
      });
      assert.equal(snapshot.files.length, count);
      assert.equal(pages.length, Math.ceil(count / 100));
      const result = CodeReviewPromptBuilder.buildBudgetedReviewPrompt({
        repoName: "repo", title: "change", description: "", headSha: "head", baseSha: "base",
        files: snapshot.files, expectedFiles: count, budget: createRequestBudget(1_000_000),
        codeContext: [], documentation: [], changedCode: null,
      });
      assert.match(result.messages[1].content, new RegExp(`new${count - 1}`));
      assert.equal(result.reviewInput.files[count - 1].inclusion, "full");
    });
  }

  test("a missing patch remains in the acquired file list", async () => {
    const result = await fetchPullRequestSnapshot(async () => metadata(1), async () => ({ files: [{ ...file(0), patch: undefined }], hasNext: false }));
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].patch, undefined);
  });

  test("a failed later page aborts without revision/network retry", async () => {
    let metadataCalls = 0;
    const pages: number[] = [];
    await assert.rejects(fetchPullRequestSnapshot(async () => { metadataCalls++; return metadata(101); }, async (page) => {
      pages.push(page);
      if (page === 2) throw new Error("page failed");
      return { files: Array.from({ length: 100 }, (_, i) => file(i)), hasNext: true };
    }), /page failed/);
    assert.deepEqual(pages, [1, 2]);
    assert.equal(metadataCalls, 1);
  });

  test("duplicates and mismatched counts are rejected", async () => {
    for (const files of [[file(1), file(1)], [file(1)]]) {
      await assert.rejects(fetchPullRequestSnapshot(async () => metadata(2), async () => ({ files, hasNext: false })), /GITHUB_PR_FILES_INCOMPLETE/);
    }
  });

  for (const changesBase of [false, true]) {
    test(`restarts once after a ${changesBase ? "base" : "head"} push during pagination`, async () => {
      const before = metadata(101);
      const after = metadata(101, changesBase ? "head" : "head2", changesBase ? "base2" : "base");
      let reads = 0;
      const pages: number[] = [];
      const result = await fetchPullRequestSnapshot(async () => (++reads === 1 ? before : after), async (page) => {
        pages.push(page);
        return { files: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => file((page - 1) * 100 + i)), hasNext: page === 1 };
      });
      assert.equal(result.metadata, after);
      assert.deepEqual(pages, [1, 2, 1, 2]);
      assert.equal(reads, 4);
    });
  }

  test("a second revision change is retryable failure", async () => {
    let reads = 0;
    await assert.rejects(fetchPullRequestSnapshot(async () => metadata(1, `head${++reads}`), async () => ({ files: [file(1)], hasNext: false })), /PR_REVISION_CHANGED/);
    assert.equal(reads, 4);
  });

  test("the upstream 3,000-file ceiling never becomes a complete prefix", async () => {
    let pages = 0;
    await assert.rejects(fetchPullRequestSnapshot(async () => metadata(3001), async () => { pages++; return { files: [], hasNext: false }; }), /GITHUB_PR_FILE_LIMIT/);
    assert.equal(pages, 0);
  });
});
