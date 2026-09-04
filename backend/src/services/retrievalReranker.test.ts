import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  retrievalRerankerService,
  primarySource,
  compareCandidates,
} from "./retrievalReranker.service.js";
import { RETRIEVAL_WEIGHTS, type RetrievalCandidate, type CandidateSourceType } from "../types/retrievalTypes.js";

function candidate(
  key: string,
  sources: [CandidateSourceType, number][],
  meta: { filePath?: string; startLine?: number } = {},
): RetrievalCandidate {
  return {
    identityKey: key,
    content: "x",
    dataType: "code_chunk",
    sources: sources.map(([type, similarity]) => ({
      type,
      weight: RETRIEVAL_WEIGHTS[type],
      similarity,
    })),
    score: 0,
    metadata: { filePath: meta.filePath ?? key, startLine: meta.startLine ?? 1 },
  };
}

describe("primarySource", () => {
  test("returns the STRONGEST source, not the first-seen one", () => {
    // The merger appends newly-discovered source types, so sources[0] is
    // whichever path happened to find it first. A file found as a dependency
    // and only later recognised as a test must be treated as a test.
    const c = candidate("a", [
      ["graph_dependency", 0.9], // 0.65 * 0.9 = 0.585
      ["related_test", 0.9], //     0.85 * 0.9 = 0.765  <- stronger
    ]);
    assert.equal(primarySource(c)!.type, "related_test");
  });

  test("undefined when there are no sources", () => {
    assert.equal(primarySource(candidate("a", [])), undefined);
  });
});

describe("rerankCandidates scoring", () => {
  test("single source scores weight * similarity", () => {
    const [c] = retrievalRerankerService.rerankCandidates([
      candidate("a", [["changed_file", 0.5]]),
    ]);
    assert.ok(Math.abs(c.score - 0.5) < 1e-9); // 1.0 * 0.5
  });

  test("extra sources add a bounded bonus, not a full sum", () => {
    const [c] = retrievalRerankerService.rerankCandidates([
      candidate("a", [
        ["graph_dependent", 1.0], // 0.80  <- max
        ["semantic_chunk", 1.0], //  0.45  -> * 0.25 = 0.1125
      ]),
    ]);
    // Bounded: 0.80 + 0.1125, NOT the old unbounded 1.25
    assert.ok(Math.abs(c.score - 0.9125) < 1e-9);
  });

  test("the best reachable corroborated candidate cannot outrank a full changed-file hit", () => {
    // Bounds the discount against what retrieveReviewContext can actually
    // produce. Single-class assignment means a candidate carries at most one
    // structural source, plus possibly semantic_chunk — so this pair is the
    // strongest non-changed candidate that exists:
    //   0.85 + 0.25 * 0.45 = 0.9625  <  1.0
    const corroborated = candidate("test+semantic", [
      ["related_test", 1.0],
      ["semantic_chunk", 1.0],
    ]);
    const changed = candidate("changed", [["changed_file", 1.0]]);

    const ranked = retrievalRerankerService.rerankCandidates([corroborated, changed]);
    assert.equal(ranked[0].identityKey, "changed");
    assert.ok(corroborated.score < 1.0, `expected < 1.0, got ${corroborated.score}`);
  });

  test("the discount actually discounts — score is well below the raw sum", () => {
    const [c] = retrievalRerankerService.rerankCandidates([
      candidate("a", [
        ["related_test", 1.0], //    0.85
        ["semantic_chunk", 1.0], //  0.45
      ]),
    ]);
    const rawSum = 0.85 + 0.45; // what the old unbounded formula produced
    assert.ok(c.score < rawSum, "must not be a plain sum");
    assert.ok(Math.abs(c.score - 0.9625) < 1e-9);
  });

  test("no sources scores zero rather than NaN", () => {
    const [c] = retrievalRerankerService.rerankCandidates([candidate("a", [])]);
    assert.equal(c.score, 0);
  });
});

describe("compareCandidates determinism", () => {
  test("equal scores break by file path, then start line", () => {
    // Ties used to fall through to stable-sort emission order, which depends
    // on graph traversal order — nondeterministic under indexQueue concurrency.
    const b2 = candidate("b2", [["changed_file", 0.5]], { filePath: "b.ts", startLine: 20 });
    const b1 = candidate("b1", [["changed_file", 0.5]], { filePath: "b.ts", startLine: 10 });
    const a1 = candidate("a1", [["changed_file", 0.5]], { filePath: "a.ts", startLine: 99 });

    const forward = retrievalRerankerService.rerankCandidates([b2, b1, a1]).map((c) => c.identityKey);
    const reversed = retrievalRerankerService.rerankCandidates([a1, b1, b2]).map((c) => c.identityKey);

    assert.deepEqual(forward, ["a1", "b1", "b2"]);
    assert.deepEqual(forward, reversed, "input order must not affect output order");
  });

  test("higher score always wins regardless of path", () => {
    const low = candidate("low", [["semantic_chunk", 0.9]], { filePath: "a.ts" });
    const high = candidate("high", [["changed_file", 0.9]], { filePath: "z.ts" });

    // compareCandidates reads the precomputed .score, so rank first — the
    // path tiebreak only applies once scores are genuinely equal.
    retrievalRerankerService.rerankCandidates([low, high]);

    assert.ok(compareCandidates(high, low) < 0);
  });
});
