import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decideIndexReadiness } from "./indexReadiness.js";

describe("decideIndexReadiness", () => {
  test("a complete index is served even after the freshness-sync wait ran out", () => {
    assert.equal(decideIndexReadiness({ lastIndexedSha: "abc123", status: "INDEXING" }, true), "ready");
  });

  test("a complete index survives a run that failed before touching it", () => {
    assert.equal(decideIndexReadiness({ lastIndexedSha: "abc123", status: "FAILED" }, false), "ready");
  });

  test("an index without a sha is never served, however long we waited", () => {
    assert.equal(decideIndexReadiness({ lastIndexedSha: null, status: "INDEXING" }, false), "wait");
    assert.equal(decideIndexReadiness({ lastIndexedSha: null, status: "INDEXING" }, true), "timed-out");
    assert.equal(decideIndexReadiness({ lastIndexedSha: null, status: "READY" }, true), "timed-out");
    assert.equal(decideIndexReadiness({ lastIndexedSha: undefined, status: undefined }, true), "timed-out");
  });

  test("a failed run without a valid index is reported as failed", () => {
    assert.equal(decideIndexReadiness({ lastIndexedSha: null, status: "FAILED" }, false), "failed");
    assert.equal(decideIndexReadiness({ lastIndexedSha: null, status: "FAILED" }, true), "failed");
  });
});
