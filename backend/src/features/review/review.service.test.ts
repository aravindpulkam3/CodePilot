import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { LLMService } from "../../infrastructure/llm/llm.service.js";
import { CodeReviewPromptBuilder } from "./codeReviewPromptBuilder.js";
import { createRequestBudget } from "../../infrastructure/llm/requestBudget.js";

// Isolate only external boundaries before importing the service. Real prompt,
// output-validation and cache helpers run; no env, sockets or live services load.
const state = {
  calls: [] as string[], cache: new Map<string, string>(),
  rows: [] as any[], failSql: "", rollbackFails: false, redisFails: false,
  listRead: null as null | (() => Promise<any[]>), connects: 0, releases: 0,
  revision: { head_sha: "head", base_sha: "base" }, revisionFails: false,
  publishedLatest: [] as boolean[], missingRepo: false,
};
const client = {
  async query(sql: string, values?: any[]) {
    const operation = sql.trim().split(/\s+/).slice(0, 3).join(" ");
    state.calls.push(operation);
    if (operation === state.failSql || (operation === "ROLLBACK" && state.rollbackFails)) throw new Error(operation);
    if (sql.includes("FROM repositories")) return { rows: state.missingRepo ? [] : [{ id: "repo" }] };
    if (operation === "INSERT INTO reviews") { state.publishedLatest.push(values?.[8]); return { rows: [{ id: "new-review" }] }; }
    if (operation === "INSERT INTO review_findings") assert.equal(values?.[0], "new-review");
    return { rows: [] };
  },
  release() { state.releases++; state.calls.push("release"); },
};
const boundary = {
  async revision() {
    state.calls.push("revision");
    if (state.revisionFails) throw new Error("revision-failed");
    return state.revision;
  },
  pool: {
    async connect() { state.calls.push("connect"); state.connects++; if (state.failSql === "connect") throw new Error("connect"); return client; },
    async query(sql: string, values?: any[]) {
      if (sql.includes("SELECT * FROM reviews")) {
        state.calls.push("list-query");
        return { rows: state.listRead ? await state.listRead() : [...state.rows] };
      }
      if (sql.includes("SELECT * FROM review_findings")) {
        state.calls.push("findings-query:" + values?.[0]);
        return { rows: [{ id: "finding-" + values?.[0], review_id: values?.[0] }] };
      }
      state.calls.push("touch:" + values?.[0]);
      return { rows: [] };
    },
  },
  redis: {
    async get(key: string) { state.calls.push("get:" + key); if (state.redisFails) throw new Error("offline"); return state.cache.get(key) ?? null; },
    async setex(key: string, _ttl: number, value: string) { state.calls.push("set:" + key); if (state.redisFails) throw new Error("offline"); state.cache.set(key, value); },
    async del(...keys: string[]) { state.calls.push("invalidate"); keys.forEach((key) => state.cache.delete(key)); },
  },
};
(globalThis as any).__reviewTestBoundary = boundary;
const modules: Record<string, string> = {
  "../../config/db.js": "export const pool = globalThis.__reviewTestBoundary.pool;",
  "../../config/redis.js": "export const cacheRedisClient = globalThis.__reviewTestBoundary.redis; export const coordinationRedisClient = {};",
  "../repository/repository.service.js": "export const findRepositoryById = async () => ({id:'repo',user_id:'user',owner:'owner',name:'repo'});",
  "../../infrastructure/github/github.service.js": "export const getPullRequestDetails = async () => ({head_sha:'head',base_sha:'base',files:[]}); export const getGitHubAccessToken = async () => 'test-token'; export const getPullRequestRevision = (...args) => globalThis.__reviewTestBoundary.revision(...args);",
  "../../infrastructure/llm/llm.service.js": "export const ollamaService = {};",
  "../../infrastructure/retrieval/retreival.service.js": "export const retrievalService = {};",
  "../../shared/events/eventEmitter.js": "export const appEvents = {emit(){}}; export const EVENT_TYPES = {PR_UPDATED:'updated',PR_REVIEW_COMPLETED:'completed'};",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = modules[specifier];
    if (source) return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { ReviewService, getReviewsForPullRequest } = await import("./review.service.js");
hooks.deregister();
after(() => { delete (globalThis as any).__reviewTestBoundary; });
beforeEach(() => {
  state.calls = []; state.cache.clear(); state.rows = []; state.failSql = "";
  state.rollbackFails = false; state.redisFails = false; state.listRead = null; state.connects = 0; state.releases = 0;
  state.revision = { head_sha: "head", base_sha: "base" }; state.revisionFails = false;
  state.publishedLatest = []; state.missingRepo = false;
});

const prompt = () => CodeReviewPromptBuilder.buildBudgetedReviewPrompt({
  repoName: "repo", title: "Fix", description: "", headSha: "head", baseSha: "base",
  files: [{ filename: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }], expectedFiles: 1,
  budget: createRequestBudget(32768), codeContext: [], documentation: [], changedCode: null,
});
const review = () => ({ summary: "Finding", overall_score: 80, risk_level: "Medium", findings: [{
  severity: "Major", category: "correctness", file_path: "a.ts", line_number: 1,
  title: "Bug", description: "Cause", recommendation: "Fix", code_suggestion: null,
}] });
function service(generate: () => Promise<unknown> = async () => { state.calls.push("model"); return review(); }) {
  const instance = new ReviewService({ modelName: "test", generateStructured: generate } as unknown as LLMService);
  instance.buildReviewMessages = async () => ({ ...prompt(), changedCode: null, retrievedContext: {} as any });
  return instance;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("review transaction lifetime", () => {
  test("model completes before connect; commit/release precede invalidation", async () => {
    const result = await service().generateAndStoreReview("clerk", "repo", 1);
    assert.equal(result.reviewId, "new-review");
    assert.ok(state.calls.indexOf("model") < state.calls.indexOf("connect"));
    assert.ok(state.calls.indexOf("model") < state.calls.indexOf("revision"));
    assert.ok(state.calls.indexOf("revision") < state.calls.indexOf("connect"));
    assert.ok(state.calls.indexOf("SELECT id FROM") < state.calls.indexOf("UPDATE reviews SET"));
    assert.ok(state.calls.indexOf("COMMIT") < state.calls.indexOf("release"));
    assert.ok(state.calls.indexOf("release") < state.calls.indexOf("invalidate"));
    assert.equal(state.releases, 1);
    assert.ok(!state.calls.includes("ROLLBACK"));
  });
  test("model failure and invalid output never acquire a client", async () => {
    await assert.rejects(service(async () => { throw new Error("model-failed"); }).generateAndStoreReview("clerk", "repo", 1), /model-failed/);
    await assert.rejects(service(async () => ({})).generateAndStoreReview("clerk", "repo", 1), /REVIEW_OUTPUT_INCOMPLETE/);
    const invalid = review(); invalid.findings[0].category = "unsupported";
    await assert.rejects(service(async () => invalid).generateAndStoreReview("clerk", "repo", 1), /REVIEW_OUTPUT_INCOMPLETE/);
    assert.ok(!state.calls.includes("revision"));
    assert.equal(state.connects, 0);
    assert.equal(state.releases, 0);
  });
  for (const operation of ["BEGIN", "INSERT INTO reviews", "INSERT INTO review_findings", "COMMIT"]) {
    test(operation + " failure rolls back and releases once", async () => {
      state.failSql = operation;
      await assert.rejects(service().generateAndStoreReview("clerk", "repo", 1), { message: operation });
      assert.ok(state.calls.includes("ROLLBACK"));
      assert.equal(state.releases, 1);
      assert.ok(!state.calls.includes("invalidate"));
    });
  }
  test("connection failure has no client to release", async () => {
    state.failSql = "connect";
    await assert.rejects(service().generateAndStoreReview("clerk", "repo", 1), /connect/);
    assert.equal(state.releases, 0);
  });
  test("rollback failure preserves original error and still releases", async () => {
    state.failSql = "INSERT INTO review_findings"; state.rollbackFails = true;
    await assert.rejects(service().generateAndStoreReview("clerk", "repo", 1), { message: "INSERT INTO review_findings" });
    assert.equal(state.releases, 1);
  });
  test("two pending generations reserve no transaction connections", async () => {
    const bothStarted = deferred<void>(); const finish = deferred<unknown>(); let started = 0;
    const instance = service(async () => { if (++started === 2) bothStarted.resolve(); return finish.promise; });
    const pending = [instance.generateAndStoreReview("clerk", "repo", 1), instance.generateAndStoreReview("clerk", "repo", 2)];
    await bothStarted.promise;
    assert.equal(state.connects, 0);
    finish.resolve(review());
    await Promise.all(pending);
    assert.equal(state.connects, 2); assert.equal(state.releases, 2);
  });
});

describe("review identity and findings cache", () => {
  const row = (id: string, latest = true) => ({ id, head_sha: "same-head", is_latest: latest, raw_response: {} });
  test("same-SHA regeneration keeps findings IDs distinct and preserves history", async () => {
    state.rows = [row("A")];
    const a = await getReviewsForPullRequest("repo", 1);
    state.rows = [row("B"), row("A", false)];
    const b = await getReviewsForPullRequest("repo", 1);
    assert.equal(a.latest?.findings[0].id, "finding-A");
    assert.equal(b.latest?.findings[0].id, "finding-B");
    assert.equal(b.latest?.findings[0].review_id, "B");
    assert.deepEqual(b.history.map((r: any) => r.id), ["A"]);
    assert.ok(state.cache.has("repo:repo:pr:1:review:A:findings"));
    assert.ok(state.cache.has("repo:repo:pr:1:review:B:findings"));
  });
  test("findings hits avoid repeat lookup; mutable lists always read DB", async () => {
    state.rows = [row("A")];
    state.cache.set("repo:repo:pr:1:reviews", JSON.stringify([row("stale")]));
    await getReviewsForPullRequest("repo", 1); await getReviewsForPullRequest("repo", 1);
    assert.equal(state.calls.filter((call) => call === "findings-query:A").length, 1);
    assert.equal(state.calls.filter((call) => call === "list-query").length, 2);
    assert.ok(!state.calls.includes("get:repo:repo:pr:1:reviews"));
  });
  test("Redis read/write failures use the selected review's DB findings", async () => {
    state.rows = [row("B")]; state.redisFails = true;
    const result = await getReviewsForPullRequest("repo", 1);
    assert.equal(result.latest?.findings[0].review_id, "B");
  });
  test("an old in-flight list read cannot repopulate Redis after a new commit", async () => {
    const started = deferred<void>(); const oldRead = deferred<any[]>();
    state.listRead = async () => { started.resolve(); return oldRead.promise; };
    const oldRequest = getReviewsForPullRequest("repo", 1);
    await started.promise;
    state.rows = [row("B"), row("A", false)]; state.listRead = null;
    await boundary.redis.del("repo:repo:pr:1:reviews");
    oldRead.resolve([row("A")]); await oldRequest;
    const fresh = await getReviewsForPullRequest("repo", 1);
    assert.equal(fresh.latest?.id, "B");
    assert.ok(!state.cache.has("repo:repo:pr:1:reviews"));
  });
  test("concurrent findings misses cannot cross review identities", async () => {
    state.rows = [row("A")];
    const a = getReviewsForPullRequest("repo", 1);
    state.rows = [row("B")];
    const b = getReviewsForPullRequest("repo", 1);
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first.latest?.findings[0].review_id, "A");
    assert.equal(second.latest?.findings[0].review_id, "B");
  });
  test("no reviews preserves the empty response", async () => {
    assert.deepEqual(await getReviewsForPullRequest("repo", 1), { latest: null, history: [] });
  });
});

describe("conditional review publication", () => {
  for (const field of ["head_sha", "base_sha"] as const) {
    test(`changed ${field} saves history without demoting latest`, async () => {
      state.revision[field] = "new-revision";
      await service().generateAndStoreReview("clerk", "repo", 1);
      assert.deepEqual(state.publishedLatest, [false]);
      assert.ok(!state.calls.includes("UPDATE reviews SET"));
      assert.ok(state.calls.includes("INSERT INTO review_findings"));
      assert.ok(state.calls.includes("COMMIT"));
    });
  }
  test("verification failure never opens a publication transaction", async () => {
    state.revisionFails = true;
    await assert.rejects(service().generateAndStoreReview("clerk", "repo", 1), /revision-failed/);
    assert.equal(state.connects, 0);
  });
  test("repository deleted before locking aborts publication", async () => {
    state.missingRepo = true;
    await assert.rejects(service().generateAndStoreReview("clerk", "repo", 1), /REPO_NOT_FOUND/);
    assert.ok(state.calls.includes("ROLLBACK"));
    assert.deepEqual(state.publishedLatest, []);
  });
  test("history-only rows are never selected by API fallback", async () => {
    state.rows = [{ id: "old", is_latest: false }];
    assert.deepEqual(await getReviewsForPullRequest("repo", 1), { latest: null, history: state.rows });
    assert.deepEqual(state.calls, ["list-query"]);
  });
});

// Opt in with REVIEW_INTEGRATION_TEST=1. Only session-local temporary tables
// and UUID-scoped Redis keys are written; application rows are never touched.
test("local PostgreSQL/Redis: rollback, same-SHA history and saved finding identity", {
  skip: process.env.REVIEW_INTEGRATION_TEST !== "1",
}, async (t) => {
  await import("dotenv/config");
  const { Client } = await import("pg");
  const { Redis } = await import("ioredis");
  const { randomUUID } = await import("node:crypto");
  const repositoryId = randomUUID();
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  const redis = new Redis(process.env.REDIS_CACHE_URL || "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 5000, retryStrategy: () => null });
  redis.on("error", () => {});
  const cacheKeys = new Set<string>();
  try {
    await db.connect(); await redis.connect();
    await db.query("CREATE TEMP TABLE repositories (id UUID PRIMARY KEY)");
    await db.query("INSERT INTO repositories VALUES ($1)", [repositoryId]);
    await db.query("CREATE TEMP TABLE reviews (LIKE public.reviews INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)");
    await db.query("CREATE TEMP TABLE review_findings (LIKE public.review_findings INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)");
    await db.query("ALTER TABLE review_findings ADD FOREIGN KEY (review_id) REFERENCES pg_temp.reviews(id)");
    await db.query("ALTER TABLE review_findings ADD CHECK (title <> 'force-db-failure')");
    await db.query("CREATE TEMP TABLE saved_discussions (finding_id UUID REFERENCES pg_temp.review_findings(id))");
    t.mock.method(boundary.pool, "connect", async () => ({ query: db.query.bind(db), release() {} }) as any);
    t.mock.method(boundary.pool, "query", db.query.bind(db) as any);
    t.mock.method(boundary.redis, "get", (key: string) => redis.get(key));
    t.mock.method(boundary.redis, "setex", async (key: string, ttl: number, value: string) => { cacheKeys.add(key); await redis.setex(key, ttl, value); });
    t.mock.method(boundary.redis, "del", async (...keys: string[]) => { await redis.del(...keys); });

    await service().generateAndStoreReview("clerk", repositoryId, 1);
    const first = await getReviewsForPullRequest(repositoryId, 1);
    const firstFinding = first.latest!.findings[0].id;
    await db.query("INSERT INTO saved_discussions (finding_id) VALUES ($1)", [firstFinding]);
    const firstKey = `repo:${repositoryId}:pr:1:review:${first.latest!.id}:findings`;
    assert.ok(await redis.ttl(firstKey) > 0);

    const invalid = review(); invalid.findings[0].title = "force-db-failure";
    await assert.rejects(service(async () => invalid).generateAndStoreReview("clerk", repositoryId, 1), { code: "23514" });
    const afterFailure = await db.query("SELECT id, is_latest FROM reviews");
    assert.equal(afterFailure.rows.length, 1);
    assert.equal(afterFailure.rows[0].is_latest, true, "rollback restores the demoted previous review");

    await service().generateAndStoreReview("clerk", repositoryId, 1);
    const staleListKey = `repo:${repositoryId}:pr:1:reviews`;
    cacheKeys.add(staleListKey);
    await redis.setex(staleListKey, 300, JSON.stringify([first.latest]));
    const second = await getReviewsForPullRequest(repositoryId, 1);
    assert.notEqual(second.latest!.id, first.latest!.id);
    assert.notEqual(second.latest!.findings[0].id, firstFinding);
    assert.equal(second.latest!.head_sha, first.latest!.head_sha);
    assert.equal(second.history[0].id, first.latest!.id);
    const saved = await db.query("SELECT f.id, f.review_id FROM saved_discussions d JOIN review_findings f ON f.id = d.finding_id");
    assert.equal(saved.rows[0].id, firstFinding);
    assert.equal(saved.rows[0].review_id, first.latest!.id);
    const cached = await getReviewsForPullRequest(repositoryId, 1);
    assert.equal(cached.latest!.findings[0].id, second.latest!.findings[0].id);
  } finally {
    if (redis.status === "ready" && cacheKeys.size) await redis.del(...cacheKeys);
    redis.disconnect();
    await db.end(); // PostgreSQL drops all session-local tables.
  }
});

// Shared disposable schema: independent connections must see the same rows
// to exercise actual lock contention. Never apply the migration to public here.
test("PostgreSQL publication lock, unique invariant, cleanup and history-only persistence", {
  skip: process.env.REVIEW_INTEGRATION_TEST !== "1", timeout: 20000,
}, async (t) => {
  await import("dotenv/config");
  const { Client, Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const schema = "review_test_" + randomUUID().replaceAll("-", "");
  const repositoryId = randomUUID();
  const admin = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public -c statement_timeout=10000`, max: 4 });
  const releaseFirst = deferred<void>();
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}, public`);
    await admin.query("CREATE TABLE repositories (id UUID PRIMARY KEY)");
    await admin.query("INSERT INTO repositories VALUES ($1)", [repositoryId]);
    await admin.query("CREATE TABLE reviews (LIKE public.reviews INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
    await admin.query("ALTER TABLE reviews ADD PRIMARY KEY (id)");
    await admin.query("CREATE TABLE review_findings (LIKE public.review_findings INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
    await admin.query("ALTER TABLE review_findings ADD PRIMARY KEY (id), ADD FOREIGN KEY (review_id) REFERENCES reviews(id), ADD CHECK (title <> 'force-db-failure')");
    await admin.query("CREATE TABLE saved_discussions (finding_id UUID REFERENCES review_findings(id))");
    const insert = "INSERT INTO reviews (repository_id,pull_number,head_sha,model,raw_response,is_latest) VALUES ($1,$2,'head','test','{}',TRUE) RETURNING id";
    const legacyA = (await admin.query(insert, [repositoryId, 99])).rows[0].id;
    await admin.query(insert, [repositoryId, 99]);
    const finding = (await admin.query("INSERT INTO review_findings (review_id,severity,category,file_path,title,description,recommendation) VALUES ($1,'Major','correctness','a.ts','Bug','Cause','Fix') RETURNING id", [legacyA])).rows[0].id;
    await admin.query("INSERT INTO saved_discussions VALUES ($1)", [finding]);
    const sql = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    const migration = sql.slice(sql.indexOf("-- C12:")).match(/DO \$\$[\s\S]*?END \$\$;/)![0];
    await admin.query(migration);
    await admin.query(migration); // Rerunning the schema must preserve identity/history.
    assert.equal((await admin.query("SELECT * FROM reviews WHERE pull_number=99")).rowCount, 2);
    assert.equal((await admin.query("SELECT * FROM reviews WHERE pull_number=99 AND is_latest")).rowCount, 1);
    assert.equal((await admin.query("SELECT * FROM saved_discussions d JOIN review_findings f ON f.id=d.finding_id JOIN reviews r ON r.id=f.review_id")).rowCount, 1);
    await assert.rejects(admin.query(insert, [repositoryId, 99]), { code: "23505" });

    const firstLocked = deferred<void>(); const secondAttempted = deferred<void>();
    let connectionNumber = 0; let secondPid = 0;
    t.mock.method(boundary.pool, "connect", async () => {
      const connection = await db.connect(); const number = ++connectionNumber;
      if (number === 2) secondPid = (await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return { release: () => connection.release(), async query(sql: string, values?: any[]) {
        const isLock = sql.includes("FOR UPDATE");
        if (number === 2 && isLock) secondAttempted.resolve();
        const result = await connection.query(sql, values);
        if (number === 1 && isLock) { firstLocked.resolve(); await releaseFirst.promise; }
        return result;
      } } as any;
    });
    t.mock.method(boundary.pool, "query", db.query.bind(db) as any);
    const a = service().generateAndStoreReview("clerk", repositoryId, 1);
    await firstLocked.promise;
    const b = service().generateAndStoreReview("clerk", repositoryId, 1);
    await secondAttempted.promise;
    // Observe a real database wait rather than relying on completion timing.
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = (await admin.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [secondPid])).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseFirst.resolve();
    const [first, second] = await Promise.all([a, b]);
    assert.ok(blocked, "second publisher waits on the repository row lock");
    const listed = await getReviewsForPullRequest(repositoryId, 1);
    assert.equal(listed.latest!.id, second.reviewId, "last successful publication wins");
    assert.equal(listed.history[0].id, first.reviewId);
    assert.equal((await admin.query("SELECT * FROM review_findings WHERE review_id = ANY($1::uuid[])", [[first.reviewId, second.reviewId]])).rowCount, 2);

    state.revision = { head_sha: "advanced", base_sha: "base" };
    const stale = await service().generateAndStoreReview("clerk", repositoryId, 1);
    assert.equal((await getReviewsForPullRequest(repositoryId, 1)).latest!.id, second.reviewId);
    assert.equal((await admin.query("SELECT is_latest FROM reviews WHERE id=$1", [stale.reviewId])).rows[0].is_latest, false);
    await service().generateAndStoreReview("clerk", repositoryId, 2);
    const onlyHistory = await getReviewsForPullRequest(repositoryId, 2);
    assert.equal(onlyHistory.latest, null); assert.equal(onlyHistory.history.length, 1);

    state.revision = { head_sha: "head", base_sha: "base" };
    const invalid = review(); invalid.findings[0].title = "force-db-failure";
    await assert.rejects(service(async () => invalid).generateAndStoreReview("clerk", repositoryId, 1), { code: "23514" });
    assert.equal((await getReviewsForPullRequest(repositoryId, 1)).latest!.id, second.reviewId);
  } finally {
    releaseFirst.resolve();
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
