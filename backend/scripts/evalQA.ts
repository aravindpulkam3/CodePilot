import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hash, validateManifest, newAdjudication, summarize, compareSummaries, markdown, event, type Manifest, type Artifact } from "./qa-eval/evaluation.js";
import { assertIndex, assertIndexUnchanged } from "./review-eval/evaluation.js";

const here = path.dirname(fileURLToPath(import.meta.url)), backend = path.resolve(here, "..");
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
function runDir(label: string) {
  if (!label || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label)) throw new Error("Use a simple run label");
  return path.join(here, "qa-eval-out", label);
}
function sourceVersion() {
  const files: Record<string, string> = {};
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (!entry.name.endsWith(".test.ts")) files[path.relative(backend, file).replaceAll("\\", "/")] = hash(fs.readFileSync(file).toString("base64"));
    }
  }
  visit(path.join(backend, "src")); visit(path.join(backend, "parsers"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: backend, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { commit: git("rev-parse", "HEAD"), dirty: !!git("status", "--porcelain"), sourceHash: hash(files), files,
    lockfileHash: hash(fs.readFileSync(path.join(backend, "package-lock.json"), "utf8")),
    evaluatorHash: hash([fs.readFileSync(fileURLToPath(import.meta.url), "utf8"), fs.readFileSync(path.join(here, "qa-eval/evaluation.ts"), "utf8")]) };
}
function score(dir: string) {
  const run = read(path.join(dir, "run.json")), m: Manifest = read(path.join(dir, "manifest.json"));
  if (hash(m) !== run.datasetHash) throw new Error("Saved dataset changed");
  const verification = read(path.join(dir, "verification.json"));
  if (hash(verification) !== run.verificationHash) throw new Error("Saved ground truth verification changed");
  const j = read(path.join(dir, "adjudications.json"));
  if (j.runId !== run.runId || j.datasetHash !== run.datasetHash) throw new Error("Wrong adjudication run/dataset");
  const summary = summarize(m, m.cases.map(c => read(path.join(dir, `${c.id}.json`))), j.cases);
  const scored = { ...summary, scoring: { at: new Date().toISOString(), adjudicationHash: hash(j), scorerHash: hash(fs.readFileSync(path.join(here, "qa-eval/evaluation.ts"), "utf8")) } };
  write(path.join(dir, "summary.json"), scored);
  fs.writeFileSync(path.join(dir, "summary.md"), markdown(summary));
  return { run, summary: scored };
}
const safeError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, "[URL redacted]").slice(0, 1500);

async function run(label: string) {
  process.chdir(backend);
  const m: Manifest = read(path.join(here, "qa-eval/cases.json")); validateManifest(m);
  const verification = read(path.join(here, "qa-eval/verification.json"));
  if (verification.status !== "passed" || verification.sha !== m.expectedIndexSha || verification.datasetHash !== hash(m) || verification.testsHash !== hash(fs.readFileSync(path.join(here, "qa-eval/behavior.test.mjs"), "utf8")) || verification.verifierHash !== hash(fs.readFileSync(path.join(here, "qa-eval/verify.mjs"), "utf8"))) throw new Error("Run eval:qa:verify: ground truth evidence is missing, stale, or failed");
  const dir = runDir(label);
  if (fs.existsSync(dir)) throw new Error("Run exists; choose a new label");
  fs.mkdirSync(dir, { recursive: true });
  const metadata: any = { version: 1, runId: label, datasetHash: hash(m), verificationHash: hash(verification), startedAt: new Date().toISOString(), codepilot: sourceVersion(),
    machine: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    cachePolicy: "Existing caches reused, no warmup/flush, sequential cases", historyPolicy: "Fixed prefix plus current user; last 10 ordered messages; no persisted sessions",
    embedding: { model: "gemini-embedding-001", task: "RETRIEVAL_QUERY", dimensions: 3072, cost: null }, indexingSetupCost: null,
    generationPolicy: "Production repository Q&A Gemini stream; temperature 0.2; up to five attempts before first text, with 1/2/4/8-second backoff; no replay after partial output; token usage covers the returned response only (failed-attempt usage unknown)", promptTokenEstimate: null, cost: null };
  const artifacts = new Map<string, Artifact>(), adjudications: Record<string, any> = {};
  write(path.join(dir, "manifest.json"), m); write(path.join(dir, "verification.json"), verification); write(path.join(dir, "run.json"), metadata);
  const save = (c: Manifest["cases"][number], a: Artifact) => {
    artifacts.set(c.id, a); write(path.join(dir, `${c.id}.json`), a); adjudications[c.id] = newAdjudication(c, a);
    write(path.join(dir, "adjudications.json"), { version: 1, runId: label, datasetHash: hash(m), cases: adjudications });
  };
  let pool: any, queues: any, redis: any;
  try {
    await import("dotenv/config");
    for (const key of ["DATABASE_URL", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"]) if (!process.env[key]) throw new Error(`Missing ${key}`);
    ({ pool } = await import("../src/config/db.js")); pool.options.connectionTimeoutMillis = 10000;
    ({ queues } = await import("../src/config/queues.js")); redis = await import("../src/config/redis.js");
    const [owner, name] = m.githubRepository.split("/");
    const { rows } = await pool.query(`SELECT r.id, r.user_id, u.clerk_id FROM repositories r JOIN app_users u ON u.id=r.user_id
      WHERE r.owner=$1 AND r.name=$2 AND ($3::uuid IS NULL OR r.id=$3) AND ($4::text IS NULL OR u.clerk_id=$4)`, [owner, name, option("--repository-id") ?? null, option("--clerk-user-id") ?? null]);
    if (rows.length !== 1) throw new Error(`Expected one owned benchmark index, found ${rows.length}; select --repository-id / --clerk-user-id`);
    const identity = rows[0];
    const { findOwnedRepositoryById } = await import("../src/features/repository/repository.service.js");
    if (!await findOwnedRepositoryById(identity.id, identity.user_id)) throw new Error("RESOURCE_NOT_FOUND");
    metadata.repositoryId = identity.id;
    async function indexState() {
      // A single SQL statement gives the fingerprint one database snapshot.
      const { rows } = await pool.query(`SELECT indexing_status,last_indexed_sha,indexing_run_id,indexing_target_sha,index_chunks_total,completed_index_chunks,
        (SELECT count(*)::int FROM repository_embeddings WHERE repository_id=r.id) AS chunks,
        (SELECT array_agg(DISTINCT commit_sha ORDER BY commit_sha) FROM repository_embeddings WHERE repository_id=r.id) AS revisions,
        (SELECT md5(string_agg(md5(e::text),'' ORDER BY file_path,content_hash)) FROM repository_embeddings e WHERE repository_id=r.id) AS digest,
        (SELECT count(*)::int FROM repository_imports WHERE repository_id=r.id) AS edges,
        (SELECT md5(string_agg(md5(i::text),'' ORDER BY source_path,target,resolved)) FROM repository_imports i WHERE repository_id=r.id) AS graph_digest
        FROM repositories r WHERE id=$1 AND user_id=$2`, [identity.id, identity.user_id]);
      if (!rows[0]) throw new Error("RESOURCE_NOT_FOUND"); return rows[0];
    }
    const initialIndex = await indexState(); assertIndex(initialIndex, m.expectedIndexSha); metadata.index = initialIndex;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([redis.cacheRedisClient.ping(), redis.queueConnection.ping()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Redis preflight timed out")), 10000); })]); } finally { clearTimeout(timer); }
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
    const { repositoryQALLM } = await import("../src/infrastructure/llm/llm.service.js");
    const { GENERATION_RETRY } = await import("../src/infrastructure/llm/providerRetry.js");
    metadata.model = { provider: "gemini", name: repositoryQALLM.modelName, temperature: 0.2,
      retry: GENERATION_RETRY, sdkAttemptsPerRequest: 1, maxOutputTokens: null };
    const { generateChatResponse } = await import("../src/features/chat/chatGeneration.js");
    const { RepositoryContextProvider } = await import("../src/features/chat/providers/repositoryContext.provider.js");
    const provider = new RepositoryContextProvider();
    write(path.join(dir, "run.json"), metadata);
    for (const c of m.cases) {
      const a: Artifact = { caseId: c.id, status: "failed", answer: "", events: [], elapsedMs: 0 }, started = performance.now();
      console.log(`[QA Eval] ${c.id}`);
      try {
        a.indexBefore = await indexState(); assertIndexUnchanged(initialIndex, a.indexBefore, m.expectedIndexSha);
        const now = new Date().toISOString();
        const history = [...(c.history ?? []), { role: "user" as const, content: c.question }].slice(-10);
        await generateChatResponse(provider, repositoryQALLM, { id: randomUUID(), user_id: identity.user_id, type: "REPO_QA", repository_id: identity.id, status: "ACTIVE", created_at: now, updated_at: now }, c.question, identity.clerk_id, history,
          chunk => { if (chunk.type === "text") a.answer += chunk.data; },
          { isNewSession: !c.history?.length, skipSync: true, onDiagnostic: e => a.events.push(e) });
        a.indexAfter = await indexState(); assertIndexUnchanged(initialIndex, a.indexAfter, m.expectedIndexSha);
        if (["qa.retrieved", "qa.budgeted", "qa.request", "qa.usage", "qa.response"].some(s => !event(a, s))) throw new Error("EVAL_DIAGNOSTICS_INCOMPLETE");
        if (!a.answer.trim() || event(a, "qa.usage").doneReason !== "STOP") throw new Error("Incomplete model answer");
        a.status = "complete";
      } catch (e) { a.error = safeError(e); a.status = a.error.startsWith("EVAL_") ? "invalid" : "failed"; process.exitCode = 1; }
      finally { a.elapsedMs = performance.now() - started; save(c, a); console.log(`[QA Eval] ${c.id}: ${a.status}, ${(a.elapsedMs / 1000).toFixed(1)}s${a.error ? ` (${a.error})` : ""}`); }
    }
    metadata.finalIndex = await indexState(); assertIndexUnchanged(initialIndex, metadata.finalIndex, m.expectedIndexSha);
  } catch (e) {
    metadata.error = safeError(e); process.exitCode = 1;
    if (metadata.error.startsWith("EVAL_")) for (const c of m.cases) {
      const a = artifacts.get(c.id);
      if (a) save(c, { ...a, status: "invalid", error: metadata.error });
    }
    for (const c of m.cases) if (!artifacts.has(c.id)) save(c, { caseId: c.id, status: "failed", answer: "", events: [], elapsedMs: 0, error: metadata.error });
    console.error(`[QA Eval] ${metadata.error}`);
  } finally {
    metadata.finishedAt = new Date().toISOString(); write(path.join(dir, "run.json"), metadata);
    if (queues) await Promise.allSettled(Object.values(queues).map((q: any) => q.disconnect()));
    if (redis) { redis.cacheRedisClient.disconnect(); redis.queueConnection.disconnect(); redis.coordinationRedisClient.disconnect(); }
    if (pool) await pool.end();
    score(dir); console.log(`Results: ${path.join(dir, "summary.md")}`);
  }
}
function compare(left: string, right: string) {
  const a = score(runDir(left)), b = score(runDir(right));
  if (!a.run.index || !b.run.index || a.run.datasetHash !== b.run.datasetHash || hash(a.run.index) !== hash(b.run.index)) throw new Error("Dataset/index differ or missing: not a comparable frozen benchmark");
  const comparison = compareSummaries(a.summary, b.summary), differences = comparison.metrics;
  const promptComparison = comparison.cases.map(c => {
    const before = event(read(path.join(runDir(left), c.id + ".json")), "qa.request")?.messages;
    const after = event(read(path.join(runDir(right), c.id + ".json")), "qa.request")?.messages;
    return { caseId: c.id, applicationMessagesIdentical: !!before && !!after && hash(before) === hash(after), beforeHash: before ? hash(before) : null, afterHash: after ? hash(after) : null };
  });
  const result = { baseline: left, candidate: right, promptComparison, caution: "One run is descriptive, not statistical evidence. Semantic deltas require identical finalized subsets. Model/cache/machine changes can affect results; matching application messages do not mean provider wire formats or tokenizers are identical.", models: [a.run.model, b.run.model], codepilot: [a.run.codepilot.sourceHash, b.run.codepilot.sourceHash], ...comparison };
  const dir = runDir(right); write(path.join(dir, `compare-${left}.json`), result);
  fs.writeFileSync(path.join(dir, `compare-${left}.md`), `# ${left} → ${right}\n\n${result.caution}\n\nIdentical application-level prompts: ${promptComparison.filter(c => c.applicationMessagesIdentical).length}/${promptComparison.length}.\n\n| Metric | Before | After | Delta |\n|---|---|---|---|\n` + differences.map(x => `| ${x.metric} | ${x.before ?? "unknown/unscored"} | ${x.after ?? "unknown/unscored"} | ${x.delta ?? "n/a"} |`).join("\n") + "\n\nPer-case evidence, answers, usage and semantic verdicts are in the companion JSON.\n");
  console.log(JSON.stringify(differences, null, 2));
}
try {
  if (args[0] === "run") await run(args[1]);
  else if (args[0] === "score") console.log(JSON.stringify(score(runDir(args[1])).summary.aggregate, null, 2));
  else if (args[0] === "compare") compare(args[1], args[2]);
  else throw new Error("Usage: eval:qa run <label> [--repository-id UUID] | score <label> | compare <baseline> <candidate>");
} catch (e) { console.error(safeError(e)); process.exitCode = 1; }
