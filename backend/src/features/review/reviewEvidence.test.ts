import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { verifyReviewEvidence } from "./reviewEvidence.js";
import type { RetrievedContext } from "../../infrastructure/retrieval/retrievalTypes.js";
import type { ChunkMetadata } from "../../infrastructure/chunking/astChunking.service.js";

const context = (): RetrievedContext => ({
  repositoryProfile: "Unverified default-branch profile",
  codeChunks: [{ filePath: "caller.ts", symbolName: "caller", symbolType: "graph_dependent", content: "old indexed caller", contentHash: "old-hash", commitSha: "old-head", lineStart: 1, lineEnd: 3, similarity: 1 }],
  docChunks: [], metadata: { mode: "review", usedFallback: false, query: "change" },
});
const chunk = (content: string): ChunkMetadata => ({
  file_path: "caller.ts", language: "TypeScript", symbol_name: "caller", symbol_type: "function",
  start_line: 20, end_line: 22, content, content_hash: "hash",
});

describe("revision-correct review evidence", () => {
  test("an unchanged caller is fetched at PR head and receives new content and coordinates", async () => {
    const refs: string[] = [];
    const result = await verifyReviewEvidence(context(), "pr-head", {
      fetchContent: async (_path, ref) => { refs.push(ref); return "new caller with guard"; },
      chunkFile: async (_path, source) => [chunk(source)], supportsFile: () => true,
      chunkDocument: async () => [],
    });
    assert.deepEqual(refs, ["pr-head"]);
    assert.equal(result.context.codeChunks[0].content, "new caller with guard");
    assert.equal(result.context.codeChunks[0].lineStart, 20);
    assert.equal(result.context.codeChunks[0].commitSha, "pr-head");
    assert.equal(result.context.codeChunks[0].contentHash, "hash");
    assert.equal(result.context.repositoryProfile, null);
    assert.equal(result.excluded.length, 0);
  });

  test("source absent at the target revision is excluded, never replaced by indexed content", async () => {
    const result = await verifyReviewEvidence(context(), "pr-head", {
      fetchContent: async () => null, chunkFile: async () => { throw new Error("must not parse"); },
      supportsFile: () => true, chunkDocument: async () => [],
    });
    assert.equal(result.context.codeChunks.length, 0);
    assert.match(result.excluded[0].reason, /Not present/);
  });

  test("source/parse failures and removed symbols are explicit exclusions", async () => {
    for (const unavailable of [true, false]) {
      const result = await verifyReviewEvidence(context(), "pr-head", {
        fetchContent: async () => { if (unavailable) throw new Error("403"); return "different function"; },
        chunkFile: async () => [{ ...chunk("different"), symbol_name: "other" }],
        supportsFile: () => true, chunkDocument: async () => [],
      });
      assert.equal(result.context.codeChunks.length, 0);
      assert.equal(result.excluded.length, 1);
    }
  });

  test("mixed index candidates cannot supply mixed-revision evidence", async () => {
    const input = context();
    input.codeChunks.push({ ...input.codeChunks[0], filePath: "other.ts", commitSha: "another-index-revision", content: "partially updated index" });
    const refs: string[] = [];
    const result = await verifyReviewEvidence(input, "pinned", {
      fetchContent: async (path, ref) => { refs.push(ref); return `HEAD ${path}`; },
      chunkFile: async (_path, source) => [chunk(source)], supportsFile: () => true, chunkDocument: async () => [],
    });
    assert.deepEqual(refs, ["pinned", "pinned"]);
    assert.ok(result.context.codeChunks.every((item) => item.content.startsWith("HEAD") && item.commitSha === "pinned"));
  });

  test("multiple candidates in a file share one source read and documentation is refreshed too", async () => {
    const input = context();
    input.codeChunks.push({ ...input.codeChunks[0] });
    input.docChunks = [{ ...input.codeChunks[0], filePath: "README.md", symbolName: "Setup", sectionPath: "Setup" }];
    const paths: string[] = [];
    const result = await verifyReviewEvidence(input, "pinned", {
      fetchContent: async (path) => { paths.push(path); return "new source"; },
      chunkFile: async () => [chunk("new caller")], supportsFile: () => true,
      chunkDocument: async () => [{ ...chunk("new docs"), symbol_name: "Setup" }],
    });
    assert.deepEqual(paths, ["caller.ts", "README.md"]);
    assert.equal(result.context.docChunks[0].content, "new docs");
    assert.equal(result.context.docChunks[0].commitSha, "pinned");
    assert.equal(result.context.docChunks[0].contentHash, "hash");
  });
});
