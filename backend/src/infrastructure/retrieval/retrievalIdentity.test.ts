import { after, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { CodeChunkSearchResult } from "./retrievalTypes.js";
import { candidateMergerService } from "./candidateMerger.service.js";

const row = (hash: string, sha = "head", path = "a.ts") => ({
  file_path: path, content_hash: hash, commit_sha: sha, content: `code ${hash}`,
  symbol_name: hash, symbol_type: "function", start_line: 1, end_line: 1, similarity_score: 0.9,
});
let rows = [row("part1"), row("part2")];
const client = {
  async query(sql: string, values: any[]) {
    assert.match(sql, /content_hash/); assert.match(sql, /commit_sha/);
    const selected = Array.isArray(values[2]) ? rows.filter((r) => values[2].includes(r.file_path)) : rows;
    return { rows: selected };
  }, release() {},
};
(globalThis as any).__identityBoundary = {
  pool: { connect: async () => client },
  graph: {
    getDirectDependenciesForFiles: async () => new Map([["changed.ts", ["a.ts"]]]),
    getDirectDependentsForFiles: async () => new Map(),
  },
};
const mocks: Record<string, string> = {
  "../../config/db.js": "export const pool = globalThis.__identityBoundary.pool;",
  "../../config/queues.js": "export const syncQueue = {};",
  "../../features/repository/repositorySync.service.js": "export const repositorySyncService = {};",
  "../../features/repository/repositoryGraph.service.js": "export const repositoryGraphService = globalThis.__identityBoundary.graph;",
  "./repositoryMap.service.js": "export const repositoryMapService = {getRepositoryProfile:async()=>({text:''})};",
  "../embedding/embedding.service.js": "export const embedder = {embedQuery:async()=>[0]};",
  "../../shared/utils/cache.js": "export const withCache = async (_k,_ttl,fn)=>fn();",
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (mocks[specifier]) return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  return next(specifier, context);
} });
const { retrievalService } = await import("./retreival.service.js");
const { semanticRetrievalService } = await import("./semanticRetrieval.service.js");
hooks.deregister();
after(() => { delete (globalThis as any).__identityBoundary; });

test("overlapping parts survive SQL mapping, merging, ranking, budgeting and final conversion", async (t) => {
  t.mock.method(retrievalService as any, "assertSearchable", async () => {});
  rows = [row("part1"), row("part2")];
  const result = await retrievalService.retrieveReviewContext("user", "repo", "change", ["changed.ts"], { maxTokens: 1000 }, null, { skipSync: true });
  assert.deepEqual(result.codeChunks.map((c) => [c.contentHash, c.commitSha, c.content]), [
    ["part1", "head", "code part1"], ["part2", "head", "code part2"],
  ]);
  assert.equal(result.metadata.trace!.counts.totalPreMerge, 4);
  assert.equal(result.metadata.trace!.counts.totalPostMerge, 2);
  assert.equal(result.metadata.trace!.counts.finalAccepted, 2);
  assert.equal(result.metadata.trace!.droppedCandidates.filter((c) => c.reason === "deduplicated").length, 2);
});

test("same chunk merges sources; different path, revision and content retain separate identities", () => {
  const chunk: CodeChunkSearchResult = { filePath: "a.ts", commitSha: "head", contentHash: "hash",
    content: "body", symbolName: "fn", symbolType: "function", lineStart: 1, lineEnd: 1, similarity: 0.9 };
  // Exercise the existing private conversion without introducing a public helper for testing.
  const candidate = (value: CodeChunkSearchResult, source: string) => (retrievalService as any).chunkToCandidate(value, source);
  const merged = candidateMergerService.mergeCandidates([
    candidate(chunk, "graph_dependency"), candidate(chunk, "semantic_chunk"),
    candidate({ ...chunk, similarity: 0.1 }, "semantic_chunk"),
    candidate({ ...chunk, contentHash: "other", content: "other" }, "semantic_chunk"),
    candidate({ ...chunk, commitSha: "other-head" }, "semantic_chunk"),
    candidate({ ...chunk, filePath: "b.ts" }, "semantic_chunk"),
  ]);
  assert.equal(merged.candidates.length, 4);
  assert.deepEqual(merged.candidates[0].sources.map((s) => [s.type, s.similarity]), [["graph_dependency", 0.9], ["semantic_chunk", 0.9]]);
  assert.equal(merged.candidates[0].content, "body");
});

test("documentation query also preserves stored hash and revision", async () => {
  rows = [{ ...row("doc", "doc-head", "README.md"), symbol_type: "documentation" }];
  const result = await semanticRetrievalService.searchDocumentationChunks("repo", "[0]");
  assert.equal(result[0].contentHash, "doc"); assert.equal(result[0].commitSha, "doc-head");
});
