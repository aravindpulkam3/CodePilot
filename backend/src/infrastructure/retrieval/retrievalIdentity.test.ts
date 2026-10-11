import { CodeReviewPromptBuilder } from "../../features/review/codeReviewPromptBuilder.js";
import { createRequestBudget, requestFits } from "../llm/requestBudget.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { CodeChunkSearchResult } from "./retrievalTypes.js";
import { candidateMergerService } from "./candidateMerger.service.js";

const row = (hash: string, sha = "head", path = "a.ts") => ({
  file_path: path, content_hash: hash, commit_sha: sha, content: `code ${hash}`,
  symbol_name: hash, symbol_type: "function", start_line: 1, end_line: 1, similarity_score: 0.9,
});
let indexState = { last_indexed_sha: "head", indexing_status: "READY", indexing_run_id: "run-1" };
let rows = [row("part1"), row("part2")];
const client = {
  async query(sql: string, values: any[]) {
    assert.match(sql, /content_hash/); assert.match(sql, /commit_sha/);
    const selected = Array.isArray(values[2]) ? rows.filter((r) => values[2].includes(r.file_path)) : rows;
    return { rows: selected };
  }, release() {},
};
(globalThis as any).__identityBoundary = {
  pool: { connect: async () => client, query: async () => ({ rows: [{ ...indexState }] }) },
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

test("QA frozen-index mode changes only readiness; conversational query and retrieval stay identical", async (t) => {
  const readiness: string[] = [];
  t.mock.method(retrievalService as any, "assertSearchable", async () => { readiness.push("assert"); });
  t.mock.method(retrievalService as any, "ensureSearchable", async () => { readiness.push("ensure"); });
  t.mock.method(semanticRetrievalService, "getQueryVectorStr", async () => "[0]");
  t.mock.method(semanticRetrievalService, "searchDocumentationChunks", async () => []);
  t.mock.method(semanticRetrievalService, "searchCodeChunks", async () => []);
  const recentHistory = [{ role: "user" as const, content: "What happens to reserved notebook stock when the reservation expires?" }, { role: "assistant" as const, content: "Stock returns." }, { role: "user" as const, content: "Which function restores those units, and why only once?" }];
  const plain = await retrievalService.retrieveQAContext("user", "repo", recentHistory[2].content, undefined, { isNewSession: true, recentHistory });
  const frozen = await retrievalService.retrieveQAContext("user", "repo", recentHistory[2].content, undefined, { isNewSession: true, recentHistory, skipSync: true });
  assert.deepEqual(frozen, plain);
  assert.deepEqual(readiness, ["ensure", "assert"]);
  assert.equal(frozen.metadata.usedConversationalBlend, true);
  assert.match(frozen.metadata.embeddingQuery!, /referring back to: What happens to reserved/);
});

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

test("initial observations precede selection and cannot mutate ranked evidence", async (t) => {
  t.mock.method(retrievalService as any, "assertSearchable", async () => {});
  rows = [row("part1"), row("part2")];
  const plain = await retrievalService.retrieveReviewContext("user", "repo", "change", ["changed.ts"], { maxTokens: 1000 }, null, { skipSync: true });
  const observed: any[] = [];
  const traced = await retrievalService.retrieveReviewContext("user", "repo", "change", ["changed.ts"], { maxTokens: 1000 }, null, {
    skipSync: true, onDiagnostic: (event) => { observed.push(structuredClone(event)); event.data.codeChunks.length = 0; },
  });
  assert.equal(observed[0].stage, "initial");
  assert.equal(observed[0].data.codeChunks.length, 4);
  assert.deepEqual(traced.codeChunks, plain.codeChunks);
  const dropped = await retrievalService.retrieveReviewContext("user", "repo", "change", ["changed.ts"], { maxTokens: 1 }, null, { skipSync: true });
  assert.equal(dropped.codeChunks.length, 0);
});

for (const change of [
  { name: "active delta", patch: { indexing_status: "INDEXING" } },
  { name: "same-SHA completed reindex", patch: { indexing_run_id: "run-2" } },
  { name: "different published revision", patch: { last_indexed_sha: "new-head" } },
  { name: "failed partial index", patch: { indexing_status: "FAILED", last_indexed_sha: "" } },
]) {
  test("QA rejects context crossing " + change.name, async (t) => {
    indexState = { last_indexed_sha: "head", indexing_status: "READY", indexing_run_id: "run-1" };
    t.after(() => { indexState = { last_indexed_sha: "head", indexing_status: "READY", indexing_run_id: "run-1" }; });
    t.mock.method(semanticRetrievalService, "getQueryVectorStr", async () => "[0]");
    t.mock.method(semanticRetrievalService, "searchDocumentationChunks", async () => []);
    t.mock.method(semanticRetrievalService, "searchCodeChunks", async () => {
      Object.assign(indexState, change.patch);
      return [];
    });
    await assert.rejects(retrievalService.retrieveQAContext("user", "repo", "q", undefined,
      { isNewSession: false, recentHistory: [] }), /INDEXING_IN_PROGRESS|INDEXING_FAILED/);
  });
}

test("active delta is rejected before any evidence search", async (t) => {
  indexState.indexing_status = "INDEXING";
  t.after(() => { indexState.indexing_status = "READY"; });
  const search = t.mock.method(semanticRetrievalService, "searchCodeChunks", async () => []);
  await assert.rejects(retrievalService.retrieveQAContext("user", "repo", "q", undefined,
    { isNewSession: false, recentHistory: [] }), /INDEXING_IN_PROGRESS/);
  assert.equal(search.mock.callCount(), 0);
});

test("PostgreSQL: reject reads crossing chunk writes and same-SHA publication", {
  skip: process.env.INDEX_INTEGRATION_TEST !== "1",
}, async (t) => {
  await import("dotenv/config");
  const { Client } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const schema = "c5_" + randomUUID().replaceAll("-", "");
  const reader = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  const writer = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  let created = false;
  try {
    await reader.connect(); await writer.connect();
    await reader.query('CREATE SCHEMA ' + schema); created = true;
    await reader.query('SET search_path TO ' + schema);
    await writer.query('SET search_path TO ' + schema);
    await reader.query("CREATE TABLE repositories (id text PRIMARY KEY, last_indexed_sha text, indexing_status text, indexing_run_id text)");
    await reader.query("CREATE TABLE repository_embeddings (repository_id text, symbol_type text, content text)");
    await reader.query("CREATE TABLE evidence (path text PRIMARY KEY, content text)");
    await reader.query("INSERT INTO repositories VALUES ('repo', 'head', 'READY', 'run-1')");
    await reader.query("INSERT INTO evidence VALUES ('a', 'old'), ('b', 'old')");
    t.mock.method((globalThis as any).__identityBoundary.pool, "query", reader.query.bind(reader) as any);
    t.mock.method(semanticRetrievalService, "getQueryVectorStr", async () => "[0]");
    t.mock.method(semanticRetrievalService, "searchDocumentationChunks", async () => []);
    for (const complete of [false, true]) {
      await writer.query("UPDATE repositories SET indexing_status = 'READY', indexing_run_id = 'run-1'");
      await writer.query("UPDATE evidence SET content = 'old'");
      const search = t.mock.method(semanticRetrievalService, "searchCodeChunks", async () => {
        const before = await reader.query("SELECT content FROM evidence WHERE path = 'a'");
        // The real sync writer leaves READY before committing any chunk changes.
        await writer.query("UPDATE repositories SET indexing_status = 'INDEXING', indexing_run_id = 'run-2'");
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM repositories WHERE id = 'repo' FOR UPDATE");
        await writer.query("UPDATE evidence SET content = 'new' WHERE path = 'b'");
        if (complete) await writer.query("UPDATE repositories SET indexing_status = 'READY'");
        await writer.query("COMMIT");
        const after = await reader.query("SELECT content FROM evidence WHERE path = 'b'");
        assert.deepEqual([before.rows[0].content, after.rows[0].content], ['old', 'new']);
        return [];
      });
      await assert.rejects(retrievalService.retrieveQAContext("user", "repo", "q", undefined,
        { isNewSession: false, recentHistory: [] }), /INDEXING_IN_PROGRESS/);
      search.mock.restore();
    }
  } finally {
    await writer.query("ROLLBACK").catch(() => {});
    if (created) await reader.query('DROP SCHEMA ' + schema + ' CASCADE');
    await Promise.all([reader.end(), writer.end()]);
  }
});

test("legacy document indexes cannot pass the context-read boundary", async (t) => {
  t.mock.method((globalThis as any).__identityBoundary.pool, "query", async () => ({ rows: [{ ...indexState, needs_reindex: true }] }));
  await assert.rejects(retrievalService.retrieveQAContext("user", "repo", "q", undefined,
    { isNewSession: false, recentHistory: [] }), /INDEXING_IN_PROGRESS/);
});

for (const count of [5, 30, 31, 200]) {
  test("bounded importers reach review context and prompt: " + count, async (t) => {
    const utility = "src/shared/utils.ts";
    const production = Array.from({ length: count }, (_, i) => `src/feature${i}/consumer.ts`);
    const tests = ["test/utils.test.ts", "test/utils.spec.ts"];
    const graph = (globalThis as any).__identityBoundary.graph;
    let reverse = false;
    t.mock.method(graph, "getDirectDependenciesForFiles", async () => new Map());
    t.mock.method(graph, "getDirectDependentsForFiles", async () => new Map([[utility, reverse ? [...production, ...tests].reverse() : [...production, ...tests]]]));
    t.mock.method(semanticRetrievalService, "getQueryVectorStr", async () => "[0]");
    t.mock.method(semanticRetrievalService, "searchCodeChunks", async () => []);
    let productionSelection: string[] = [];
    t.mock.method(semanticRetrievalService, "searchCodeChunksInFiles", async (_repo: string, _vector: string, paths: string[], perFile: number = 3, total: number = 30) => {
      assert.equal(perFile, 3);
      if (paths.some(p => production.includes(p))) productionSelection = [...paths];
      return paths.slice(0, total).map(filePath => ({ filePath, symbolName: "consumer", symbolType: "function", content: "export function consumer() { return useUtility(); }", contentHash: filePath, commitSha: "head", lineStart: 1, lineEnd: 1, similarity: 0.8 }));
    });
    const run = () => retrievalService.retrieveReviewContext("user", "repo", "contract change", [utility, "src/feature199/change.ts"], { maxTokens: 15000 }, null, { skipSync: true });
    const result = await run();
    const selected = [...productionSelection];
    assert.equal(selected.length, Math.min(count, 30));
    assert.ok(result.codeChunks.some(c => selected.includes(c.filePath)));
    assert.ok(result.codeChunks.some(c => tests.includes(c.filePath)));
    assert.ok(result.codeChunks.filter(c => selected.includes(c.filePath)).length <= 20);
    assert.deepEqual(result.metadata.trace!.fileSets!.fanInLimited, count > 30 ? [utility] : []);
    if (count === 200) {
      assert.equal(selected[0], "src/feature199/consumer.ts");
      assert.notDeepEqual(selected, production.slice().sort().slice(0, 30));
    }
    reverse = true;
    await run();
    assert.deepEqual(productionSelection, selected);
    const prompt = CodeReviewPromptBuilder.buildBudgetedReviewPrompt({ repoName: "r", title: "change", description: "", headSha: "head", baseSha: "base", expectedFiles: 1,
      files: [{ filename: utility, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }], budget: createRequestBudget(32768), changedCode: null, documentation: [],
      codeContext: result.codeChunks.map(c => `// File: ${c.filePath}\n${c.content}`),
    });
    assert.ok(prompt.messages.some(m => m.content.includes(selected[0])));
    assert.equal(requestFits(prompt.messages, CodeReviewPromptBuilder.getReviewSchema(), prompt.reviewInput.budget), true);
  });
}
