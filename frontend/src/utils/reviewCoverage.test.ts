import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewCoverageLabel, reviewRevisionState } from "./reviewCoverage.ts";

test("old findings cannot anchor after a head or base push", () => {
  const review = { head_sha: "head", base_sha: "base" };
  assert.equal(reviewRevisionState(review, { head_sha: "head", base_sha: "base" }), "current");
  assert.equal(reviewRevisionState(review, { head_sha: "new-head", base_sha: "base" }), "outdated");
  assert.equal(reviewRevisionState(review, { head_sha: "head", base_sha: "new-base" }), "outdated");
});

test("legacy or unloaded revisions cannot enable current-diff anchors", () => {
  assert.equal(reviewRevisionState({ head_sha: "head" }, { head_sha: "head", base_sha: "base" }), "unknown");
  assert.equal(reviewRevisionState(null, { head_sha: "head", base_sha: "base" }), "unknown");
  assert.equal(reviewRevisionState({ head_sha: "head", base_sha: "base" }, undefined), "unknown");
});

test("partial UI counts unavailable files as eligible and distinguishes partly included files", () => {
  const label = reviewCoverageLabel({
    version: 1, headSha: "head", baseSha: "base", acquisition: { complete: true, expectedFiles: 4, fetchedFiles: 4 }, coverage: "partial",
    files: [
      { filename: "a.ts", status: "available", inclusion: "full", hunks: [] },
      { filename: "b.ts", status: "available", inclusion: "partial", hunks: [] },
      { filename: "c.ts", status: "unavailable", inclusion: "none", hunks: [] },
      { filename: "logo.png", status: "excluded", inclusion: "none", hunks: [] },
    ], excludedEvidence: [],
  });
  assert.equal(label, "Partial review: 2 of 3 eligible files included; 1 partially included, 1 unavailable.");
});
