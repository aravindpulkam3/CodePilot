import { after, beforeEach, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { ChunkMetadata } from "../../infrastructure/chunking/astChunking.service.js";

const state = {
  queries: [] as Array<{ sql: string; values: any[] }>, connects: 0, releases: 0, events: 0,
  existing: ["same"], chunks: [] as ChunkMetadata[], receipts: [] as number[], run: "run", lockedRun: "run",
  total: 1, providerFails: false, providerCalls: 0, failSql: "",
};
const row = (run = state.run) => ({ user_id: "user", indexing_run_id: run, indexing_target_sha: "head", completed_index_chunks: state.receipts });
const query = async (sql: string, values: any[] = []) => {
  state.queries.push({ sql, values });
  if (state.failSql && sql.includes(state.failSql)) throw new Error("database-failure");
  if (sql.includes("FROM repositories")) return { rows: [row(sql.includes("FOR UPDATE") ? state.lockedRun : state.run)] };
  if (sql.includes("SELECT DISTINCT file_path")) return { rows: [{ file_path: "a.ts" }, { file_path: "caller.ts" }] };
  if (sql.includes("SELECT content_hash")) return { rows: state.existing.map((content_hash) => ({ content_hash })) };
  if (sql.includes("RETURNING cardinality")) return { rows: [{ chunks_done: 1, index_chunks_total: state.total }] };
  return { rows: [], rowCount: 1 };
};
const boundary = {
  pool: { query, async connect() { state.connects++; return { query, release() { state.releases++; } }; } },
  appEvents: { emit() { state.events++; } },
};
(globalThis as any).__indexTestBoundary = boundary;
const mocks: Record<string, string> = {
  "../../config/db.js": "export const pool = globalThis.__indexTestBoundary.pool;",
  "../../shared/events/eventEmitter.js": "export const appEvents = globalThis.__indexTestBoundary.appEvents; export const EVENT_TYPES = {REPOSITORY_SYNCED:'synced'};",
  "../../shared/utils/cache.js": "export const withCache = async (_key, _ttl, fn) => fn();",
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (mocks[specifier]) return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  return next(specifier, context);
} });
process.env.GOOGLE_API_KEY ||= "test-key";
const { repositoryIndexer } = await import("./repositoryIndex.service.js");
const { astChunker } = await import("../../infrastructure/chunking/astChunking.service.js");
const { embedder } = await import("../../infrastructure/embedding/embedding.service.js");
hooks.deregister();
after(() => { delete (globalThis as any).__indexTestBoundary; });
const actualInit = astChunker.init.bind(astChunker);
const actualChunkFile = astChunker.chunkFile.bind(astChunker);
const actualMetadata = astChunker.extractFileAstMetadata.bind(astChunker);
const chunk = (overrides: Partial<ChunkMetadata> = {}): ChunkMetadata => ({
  file_path: "a.ts", language: "TypeScript", symbol_type: "function", symbol_name: "fn",
  qualified_name: "fn", start_line: 20, end_line: 24, content: "function fn() {}", content_hash: "same", ...overrides,
});
beforeEach((context) => {
  const t = context as TestContext;
  state.queries = []; state.connects = 0; state.releases = 0; state.events = 0; state.existing = ["same"];
  state.chunks = [chunk()]; state.receipts = []; state.run = "run"; state.lockedRun = "run";
  state.total = 1; state.providerFails = false; state.providerCalls = 0; state.failSql = "";
  t.mock.method(astChunker, "init", async () => {});
  t.mock.method(astChunker, "chunkFile", async () => state.chunks);
  t.mock.method(astChunker, "extractFileAstMetadata", async () => null);
  t.mock.method((embedder as any).ai.models, "embedContent", async (request: any) => {
    state.providerCalls++;
    return { embeddings: state.providerFails ? [] : request.contents.map(() => ({ values: Array(3072).fill(0.25) })) };
  });
});
const run = (content: string | null = "function fn() {}") => repositoryIndexer.processRepositoryUpdate("repo", "head", [{ path: "a.ts", status: "modified", content }], "run", 0);
const writes = () => state.queries.filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql.trim()));

describe("C6 empty versus missing source", () => {
  for (const existing of [["same"], []]) test("empty replacement clears chunks/outgoing imports with " + existing.length + " old chunk(s)", async () => {
    state.existing = existing;
    await run("");
    assert.equal(state.providerCalls, 0);
    assert.ok(state.queries.some((q) => q.sql.startsWith("DELETE FROM repository_embeddings") && q.values[1] === "a.ts"));
    const deletes = state.queries.filter((q) => q.sql.startsWith("DELETE FROM repository_imports"));
    assert.equal(deletes.length, 1);
    assert.match(deletes[0].sql, /source_path = \$2/);
    assert.doesNotMatch(deletes[0].sql, /target =/);
    assert.ok(state.queries.some((q) => q.sql.includes("completed_index_chunks = array_append")));
    assert.ok(state.queries.some((q) => q.sql === "COMMIT"));
    assert.equal(state.events, 1);
  });
  for (const content of [null, undefined]) test(String(content) + " content fails before writes and receipts", async () => {
    await assert.rejects(repositoryIndexer.processRepositoryUpdate("repo", "head", [{ path: "a.ts", status: "modified", content } as any], "run", 0), /Source content unavailable/);
    assert.equal(state.connects, 0); assert.equal(writes().length, 0); assert.equal(state.events, 0);
  });
  test("rename to an excluded path preserves intentional null-content cleanup", async () => {
    await repositoryIndexer.processRepositoryUpdate("repo", "head", [{ path: "new.bin", previousPath: "a.ts", status: "renamed", content: null }], "run", 0);
    assert.ok(state.queries.some((q) => q.sql.startsWith("DELETE FROM repository_embeddings") && q.values[1] === "a.ts"));
    assert.equal(state.providerCalls, 0);
  });
  test("a missing-source attempt can succeed with a corrected payload without a prior receipt", async () => {
    await assert.rejects(run(null));
    await run("");
    assert.equal(state.queries.filter((q) => q.sql.includes("completed_index_chunks = array_append")).length, 1);
  });
});

describe("C7 embedding failure cannot commit incomplete indexing", () => {
  test("provider omission rejects before deletions, inserts, graph changes or receipts; retry succeeds", async () => {
    state.chunks = [chunk({ content_hash: "new", content: "changed" })]; state.providerFails = true;
    await assert.rejects(run(), /Embedding response count/);
    assert.equal(state.connects, 0); assert.equal(writes().length, 0); assert.equal(state.events, 0);
    state.providerFails = false;
    await run();
    assert.equal(state.providerCalls, 2);
    assert.equal(state.queries.filter((q) => q.sql.includes("completed_index_chunks = array_append")).length, 1);
    assert.ok(state.queries.some((q) => q.sql.startsWith("INSERT INTO repository_embeddings")));
  });
  test("a later file's failed batch also prevents buffered earlier writes", async (t) => {
    let calls = 0;
    t.mock.method((embedder as any).ai.models, "embedContent", async () => ({ embeddings: ++calls === 1 ? [{ values: Array(3072).fill(0.5) }] : [] }));
    state.chunks = [chunk({ content_hash: "new" })];
    await assert.rejects(repositoryIndexer.processRepositoryUpdate("repo", "head", [
      { path: "a.ts", status: "modified", content: "a" }, { path: "b.ts", status: "modified", content: "b" },
    ], "run", 0));
    assert.equal(writes().length, 0); assert.equal(state.connects, 0);
  });
});

describe("C8 metadata refresh preserves embeddings and chunk identity", () => {
  test("retained hash refreshes every stored source field, including clearing nullable metadata", async () => {
    state.chunks = [chunk({ start_line: 100, end_line: 104, symbol_type: "method", symbol_name: "m", qualified_name: undefined, parent_symbol: undefined, is_exported: false, chunk_index: undefined, chunk_total: undefined })];
    await run();
    const update = state.queries.find((q) => q.sql.startsWith("UPDATE repository_embeddings"))!;
    assert.deepEqual(update.values, ["head", "repo", "a.ts", "same", 100, 104, "method", "m", null, null, false, null, null]);
    assert.doesNotMatch(update.sql, /embedding\s*=/);
    assert.equal(state.providerCalls, 0);
    assert.equal(state.queries.filter((q) => q.sql.startsWith("INSERT INTO repository_embeddings")).length, 0);
  });
  test("changed text follows normal delete/re-embed/insert while unchanged chunks reuse vectors", async () => {
    state.chunks = [chunk(), chunk({ symbol_name: "new", content: "new text", content_hash: "new" })];
    await run();
    assert.equal(state.providerCalls, 1);
    assert.equal(state.queries.filter((q) => q.sql.startsWith("INSERT INTO repository_embeddings")).length, 1);
    assert.equal(state.queries.filter((q) => q.sql.startsWith("UPDATE repository_embeddings")).length, 1);
  });
  test("a DB failure rolls back metadata changes and does not publish completion", async () => {
    state.failSql = "UPDATE repository_embeddings";
    await assert.rejects(run(), /database-failure/);
    assert.ok(state.queries.some((q) => q.sql === "ROLLBACK"));
    assert.ok(!state.queries.some((q) => q.sql === "COMMIT"));
    assert.equal(state.releases, 1); assert.equal(state.events, 0);
  });
  test("already receipted and superseded chunks still skip writes", async () => {
    state.receipts = [0]; await run();
    assert.equal(state.connects, 0);
    state.receipts = []; state.lockedRun = "new-run"; await run();
    assert.equal(writes().length, 0);
    assert.ok(state.queries.some((q) => q.sql === "ROLLBACK"));
  });
});

// Uses session-local tables only. Enable with INDEX_INTEGRATION_TEST=1.
test("PostgreSQL: empty replacement, moved metadata, vector reuse and rollback", {
  skip: process.env.INDEX_INTEGRATION_TEST !== "1",
}, async (t) => {
  await import("dotenv/config");
  const { Client } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const repositoryId = randomUUID();
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await db.connect();
    await db.query(`CREATE TEMP TABLE repositories (
      id UUID PRIMARY KEY, user_id UUID, indexing_run_id TEXT, indexing_target_sha TEXT,
      completed_index_chunks INTEGER[] DEFAULT '{}', index_chunks_total INTEGER DEFAULT 1,
      indexing_status TEXT, last_indexed_sha TEXT)`);
    await db.query("CREATE TEMP TABLE repository_embeddings (LIKE public.repository_embeddings INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)");
    await db.query("CREATE TEMP TABLE repository_imports (LIKE public.repository_imports INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)");
    await db.query("INSERT INTO repositories (id, user_id) VALUES ($1, $2)", [repositoryId, randomUUID()]);
    t.mock.method(boundary.pool, "query", db.query.bind(db) as any);
    t.mock.method(boundary.pool, "connect", async () => ({ query: db.query.bind(db), release() {} }) as any);
    t.mock.method(astChunker, "init", actualInit);
    t.mock.method(astChunker, "chunkFile", actualChunkFile);
    t.mock.method(astChunker, "extractFileAstMetadata", actualMetadata);
    const claim = async (id: string) => db.query("UPDATE repositories SET indexing_run_id=$1, indexing_target_sha=$1, completed_index_chunks='{}', indexing_status='INDEXING'", [id]);
    const process = (id: string, content: string) => repositoryIndexer.processRepositoryUpdate(repositoryId, id, [{ path: "a.ts", status: "modified", content }], id, 0);
    const rows = async () => (await db.query("SELECT *, embedding::text AS vector FROM repository_embeddings ORDER BY symbol_name")).rows;
    const repo = async () => (await db.query("SELECT * FROM repositories")).rows[0];
    const original = "export function fn() {\n  return 1;\n}";
    await claim("initial"); await process("initial", original);
    const first = (await rows())[0];
    assert.equal(state.providerCalls, 1);

    await claim("shifted"); await process("shifted", "\n\n" + original);
    const shifted = (await rows())[0];
    assert.equal(shifted.start_line, first.start_line + 2);
    assert.equal(shifted.end_line, first.end_line + 2);
    assert.equal(shifted.content_hash, first.content_hash);
    assert.equal(shifted.vector, first.vector);
    assert.equal(state.providerCalls, 1, "line movement does not re-embed");
    assert.equal(shifted.commit_sha, "shifted");

    const movedSource = "function other() { return 0; }\n\n" + original;
    await claim("moved"); await process("moved", movedSource);
    const movedRows = await rows();
    const moved = movedRows.find((row) => row.symbol_name === "fn")!;
    assert.equal(moved.content_hash, first.content_hash);
    assert.equal(moved.vector, first.vector);
    assert.equal(moved.start_line, 3);
    assert.equal(movedRows.length, 2);
    const callsBeforeReplay = state.providerCalls;
    await process("moved", movedSource);
    assert.equal(state.providerCalls, callsBeforeReplay);
    assert.equal((await rows()).length, 2, "receipt replay does not create duplicate rows");

    await claim("changed"); state.providerFails = true;
    await assert.rejects(process("changed", original.replace("return 1", "return 2")), /Embedding response count/);
    assert.deepEqual(await rows(), movedRows, "failed embedding leaves all old rows and coordinates intact");
    assert.deepEqual((await repo()).completed_index_chunks, []);
    assert.equal((await repo()).indexing_status, "INDEXING");
    state.providerFails = false; await process("changed", original.replace("return 1", "return 2"));
    const changed = (await rows())[0];
    assert.notEqual(changed.content_hash, first.content_hash);
    assert.equal((await repo()).indexing_status, "READY");
    assert.deepEqual((await repo()).completed_index_chunks, [0]);

    await db.query("ALTER TABLE repository_embeddings ADD CHECK (start_line < 100)");
    await claim("bad-metadata");
    await assert.rejects(process("bad-metadata", "\n".repeat(110) + original.replace("return 1", "return 2")), { code: "23514" });
    assert.deepEqual((await rows())[0], changed, "failed metadata update is rolled back");
    assert.deepEqual((await repo()).completed_index_chunks, []);

    await db.query("INSERT INTO repository_imports (repository_id,source_path,target,resolved) VALUES ($1,'caller.ts','a.ts',TRUE), ($1,'a.ts','dep.ts',TRUE), ($1,'a.ts','./missing',FALSE)", [repositoryId]);
    await claim("empty"); await process("empty", "");
    assert.equal((await rows()).length, 0);
    const imports = (await db.query("SELECT source_path,target,resolved FROM repository_imports")).rows;
    assert.deepEqual(imports, [{ source_path: "caller.ts", target: "a.ts", resolved: true }]);
    assert.equal((await repo()).last_indexed_sha, "empty");
    assert.equal((await repo()).indexing_status, "READY");
    const callsBeforeEmptyReplay = state.providerCalls;
    await claim("still-empty"); await process("still-empty", "");
    assert.equal(state.providerCalls, callsBeforeEmptyReplay);
    assert.equal((await rows()).length, 0);
  } finally {
    await db.end(); // Drops all temporary fixtures, including their constraints.
  }
});

test("worker retry wiring propagates failures and marks FAILED only on terminal exhaustion", async (t) => {
  const workers = new Map<string, { processor: (job: any) => Promise<any>; handlers: Map<string, (...args: any[]) => any> }>();
  class StubWorker {
    handlers = new Map<string, (...args: any[]) => any>();
    constructor(name: string, public processor: (job: any) => Promise<any>) { workers.set(name, this); }
    on(name: string, callback: (...args: any[]) => any) { this.handlers.set(name, callback); return this; }
    async close() {}
  }
  (globalThis as any).__indexWorkerTest = { Worker: StubWorker, repositoryIndexer };
  const workerMocks: Record<string, string> = {
    "bullmq": "export const Worker = globalThis.__indexWorkerTest.Worker;",
    "./config/redis.js": "export const createQueueConnection = () => ({});",
    "./config/db.js": "export const pool = globalThis.__indexTestBoundary.pool;",
    "./features/repository/repositoryIndex.service.js": "export const repositoryIndexer = globalThis.__indexWorkerTest.repositoryIndexer;",
    "./features/repository/repositorySync.service.js": "export const repositorySyncService = {};",
  };
  const oldTerm = new Set(process.listeners("SIGTERM"));
  const oldInt = new Set(process.listeners("SIGINT"));
  const workerHooks = registerHooks({ resolve(specifier, context, next) {
    if (workerMocks[specifier]) return { url: "data:text/javascript," + encodeURIComponent(workerMocks[specifier]), shortCircuit: true };
    return next(specifier, context);
  } });
  try { await import("../../worker.js"); } finally { workerHooks.deregister(); }
  t.after(() => {
    for (const listener of process.listeners("SIGTERM")) if (!oldTerm.has(listener)) process.removeListener("SIGTERM", listener);
    for (const listener of process.listeners("SIGINT")) if (!oldInt.has(listener)) process.removeListener("SIGINT", listener);
    delete (globalThis as any).__indexWorkerTest;
  });
  const worker = workers.get("RepositoryIndex")!;
  let jobState = "delayed";
  const job = { id: "job", data: { repositoryId: "repo", latestSha: "head", runId: "run", chunkIndex: 0,
    filesToIndex: [{ path: "a.ts", status: "modified", content: "changed" }] }, getState: async () => jobState };
  state.chunks = [chunk({ content_hash: "new" })]; state.providerFails = true;
  await assert.rejects(worker.processor(job), /Embedding response count/);
  await worker.handlers.get("failed")!(job, new Error("provider-failed"));
  assert.ok(!state.queries.some((q) => q.sql.includes("indexing_status = 'FAILED'")));
  jobState = "failed";
  await worker.handlers.get("failed")!(job, new Error("provider-failed"));
  const failure = state.queries.find((q) => q.sql.includes("indexing_status = 'FAILED'"))!;
  assert.deepEqual(failure.values, ["repo", "run"]);
  assert.match(failure.sql, /ELSE NULL END/);
  state.providerFails = false;
  await worker.processor(job);
  assert.ok(state.queries.some((q) => q.sql === "COMMIT"));
});
