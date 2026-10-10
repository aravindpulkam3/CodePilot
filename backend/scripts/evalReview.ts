import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  assertIndex,
  assertIndexUnchanged,
  assertSnapshot,
  hash,
  validateManifest,
  newAdjudication,
  summarize,
  markdown,
  stages,
  type Manifest,
  type Artifact,
  type Adjudication,
  type Pricing,
} from "./review-eval/evaluation.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const backend = path.resolve(here, "..");

const outRoot = path.join(here, "review-eval-out");

const args = process.argv.slice(2);
const option = (key: string) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

const write = (file: string, data: unknown) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

const runDir = (label: string) => {
  if (!label || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label))
    throw new Error("Use a simple run label, e.g. baseline-01");
  return path.join(outRoot, label);
};

function sourceVersion() {
  const git = (...gitArgs: string[]) =>
    execFileSync("git", gitArgs, {
      cwd: backend,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const digest = createHash("sha256");
  // Hash source/config actually executed, including uncommitted instrumentation.
  function visit(dir: string) {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (!entry.name.endsWith(".test.ts"))
        digest
          .update(path.relative(backend, file).replaceAll("\\", "/"))
          .update(fs.readFileSync(file));
    }
  }

  visit(path.join(backend, "src"));
  visit(path.join(backend, "parsers"));
  const sourceHash = digest.digest("hex");

  return {
    commit: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    sourceHash,
    lockfileHash: hash(
      fs.readFileSync(path.join(backend, "package-lock.json"), "utf8"),
    ),
    evaluatorHash: hash([
      fs.readFileSync(fileURLToPath(import.meta.url), "utf8"),
      fs.readFileSync(path.join(here, "review-eval/evaluation.ts"), "utf8"),
    ]),
  };
}

function saveScores(dir: string) {
  const run = read(path.join(dir, "run.json"));
  const manifest: Manifest = read(path.join(dir, "manifest.json"));
  validateManifest(manifest);
  if (hash(manifest) !== run.datasetHash)
    throw new Error(
      "Saved dataset was changed; do not silently rescore against different ground truth",
    );
  const adjudication = read(path.join(dir, "adjudications.json"));
  if (
    adjudication.runId !== run.runId ||
    adjudication.datasetHash !== run.datasetHash
  )
    throw new Error("Adjudication belongs to a different run/dataset");
  const artifacts: Artifact[] = manifest.cases.map((c) =>
    read(path.join(dir, `${c.id}.json`)),
  );
  const summary = {
    ...summarize(manifest, artifacts, adjudication.cases, run.pricing),
    scoring: {
      version: 1,
      scoredAt: new Date().toISOString(),
      adjudicationHash: hash(adjudication),
      implementationHash: hash(
        fs.readFileSync(path.join(here, "review-eval/evaluation.ts"), "utf8"),
      ),
    },
  };
  write(path.join(dir, "summary.json"), summary);
  fs.writeFileSync(path.join(dir, "summary.md"), markdown(summary));
  return { run, summary };
}

async function run(label: string) {
  process.chdir(backend); // Grammars and dotenv use backend's working directory.
  const manifest: Manifest = read(
    path.resolve(
      option("--manifest") ?? path.join(here, "review-eval/cases.json"),
    ),
  );
  validateManifest(manifest);

  const dir = runDir(label);

  if (fs.existsSync(dir))
    throw new Error(
      "Run already exists; choose a new label (saved outputs are immutable)",
    );

  fs.mkdirSync(dir, { recursive: true });

  const pricing: Pricing | undefined = option("--pricing")
    ? read(path.resolve(option("--pricing")!))
    : undefined;
  const metadata: any = {
    version: 1,
    runId: label,
    startedAt: new Date().toISOString(),
    datasetHash: hash(manifest),
    codepilot: sourceVersion(),
    machine: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      memoryBytes: os.totalmem(),
    },
    cachePolicy:
      "Existing caches reused; no warm-up, no flush, sequential cases",
    embedding: {
      model: "gemini-embedding-001",
      dimensions: 3072,
      task: "RETRIEVAL_QUERY",
      cost: null,
    },
    pricing: pricing ?? null,
    indexingSetupCost: null,
  };
  write(path.join(dir, "manifest.json"), manifest);
  write(path.join(dir, "run.json"), metadata);
  const adjudications: Record<string, Adjudication> = {};
  const artifacts = new Map<string, Artifact>();
  let pool: any;
  let queues: any;
  let redis: any;
  const save = (artifact: Artifact) => {
    artifacts.set(artifact.caseId, artifact);
    write(path.join(dir, `${artifact.caseId}.json`), artifact);
    adjudications[artifact.caseId] = newAdjudication(artifact);
    write(path.join(dir, "adjudications.json"), {
      version: 1,
      runId: label,
      datasetHash: metadata.datasetHash,
      reviewer: "",
      cases: adjudications,
    });
  };
  try {
    // Offline score/compare never import application modules or read .env.
    await import("dotenv/config");
    for (const key of [
      "DATABASE_URL",
      "CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
    ]) {
      if (!process.env[key])
        throw new Error(`Missing ${key} in backend environment`);
    }
    ({ pool } = await import("../src/config/db.js"));
    // This process is the CLI only. Bound missing-database preflight instead of
    // leaving a default, unbounded TCP connection attempt running indefinitely.
    pool.options.connectionTimeoutMillis = 10000;
    ({ queues } = await import("../src/config/queues.js"));
    redis = await import("../src/config/redis.js");

    const [owner, name] = manifest.githubRepository.split("/");

    const { rows } = await pool.query(
      `SELECT r.id, r.user_id, u.clerk_id FROM repositories r
      JOIN app_users u ON u.id = r.user_id WHERE r.owner = $1 AND r.name = $2
      AND ($3::uuid IS NULL OR r.id = $3) AND ($4::text IS NULL OR u.clerk_id = $4)`,
      [
        owner,
        name,
        option("--repository-id") ?? null,
        option("--clerk-user-id") ?? null,
      ],
    );
    if (rows.length !== 1)
      throw new Error(
        `Expected one owned benchmark index; found ${rows.length}. Use --repository-id and --clerk-user-id to select its owner, or import/index the repository first.`,
      );
    const identity = rows[0];
    const { findOwnedRepositoryById } =
      await import("../src/features/repository/repository.service.js");
    if (!(await findOwnedRepositoryById(identity.id, identity.user_id)))
      throw new Error("RESOURCE_NOT_FOUND");
    metadata.repositoryId = identity.id;
    // Local CLI is a trusted operator using the DB-mapped owner. No OAuth token
    // is accepted from the manifest or saved in artifacts.
    async function indexState() {
      const { rows: states } = await pool.query(
        `SELECT indexing_status, last_indexed_sha, indexing_run_id,
        indexing_target_sha, index_chunks_total, completed_index_chunks FROM repositories WHERE id = $1 AND user_id = $2`,
        [identity.id, identity.user_id],
      );
      if (!states[0]) throw new Error("RESOURCE_NOT_FOUND");
      const { rows: content } = await pool.query(
        `SELECT count(*)::int AS chunks,
        array_agg(DISTINCT commit_sha ORDER BY commit_sha) AS revisions,
        md5(string_agg(md5(e::text), '' ORDER BY file_path, content_hash)) AS digest
        FROM repository_embeddings e WHERE repository_id = $1`,
        [identity.id],
      );
      const { rows: graph } = await pool.query(
        `SELECT count(*)::int AS edges,
        md5(string_agg(md5(i::text), '' ORDER BY source_path, target, resolved)) AS graph_digest
        FROM repository_imports i WHERE repository_id = $1`,
        [identity.id],
      );
      return { ...states[0], ...content[0], ...graph[0] };
    }
    const initialIndex = await indexState();
    assertIndex(initialIndex, manifest.expectedIndexSha);
    metadata.index = initialIndex;
    let redisTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          redis.cacheRedisClient.ping(),
          redis.queueConnection.ping(),
        ]),
        new Promise((_, reject) => {
          redisTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "Redis preflight timed out: check cache and queue endpoints",
                ),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(redisTimer);
    }
    if (!process.env.GEMINI_API_KEY)
      throw new Error("Missing GEMINI_API_KEY in backend environment");
    const { llmService } =
      await import("../src/infrastructure/llm/llm.service.js");
    metadata.model = { provider: "gemini", name: llmService.modelName };
    // Validate capacity before incurring any generation cost. Shared generation
    // still obtains its real budget itself, exactly as production does.
    metadata.budget = await llmService.getReviewBudget();
    write(path.join(dir, "run.json"), metadata);
    const { reviewService } =
      await import("../src/features/review/review.service.js");
    for (const c of manifest.cases) {
      const a: Artifact = {
        caseId: c.id,
        status: "failed",
        elapsedMs: 0,
        events: [],
      };
      const started = performance.now();
      console.log(`[Eval] PR #${c.pullNumber}: ${c.id}`);
      try {
        a.indexBefore = await indexState();
        assertIndexUnchanged(
          initialIndex,
          a.indexBefore,
          manifest.expectedIndexSha,
        );
        await reviewService.generateReview(
          identity.clerk_id,
          identity.id,
          c.pullNumber,
          {
            skipSync: true,
            expectedRevision: { headSha: c.headSha, baseSha: c.baseSha },
            checkSnapshot: (snapshot) => assertSnapshot(c, snapshot),
            onDiagnostic: (e) => {
              a.events.push(e);
            },
          },
        );
        a.indexAfter = await indexState();
        assertIndexUnchanged(
          a.indexBefore,
          a.indexAfter,
          manifest.expectedIndexSha,
        );
        if (stages.some((stage) => !a.events.some((e) => e.stage === stage)))
          throw new Error("EVAL_DIAGNOSTICS_INCOMPLETE");
        a.status = "complete";
      } catch (error) {
        // Provider errors may contain credential-bearing request objects; save
        // only the error code/message, never serialize the error itself.
        a.error = safeMessage(error);
        a.status = a.error.startsWith("EVAL_") ? "invalid" : "failed";
        process.exitCode = 1;
      } finally {
        a.elapsedMs = performance.now() - started;
        save(a);
        console.log(
          `[Eval] ${c.id}: ${a.status}, ${(a.elapsedMs / 1000).toFixed(1)}s${a.error ? ` (${a.error})` : ""}`,
        );
      }
    }
  } catch (error) {
    metadata.error = safeMessage(error);
    process.exitCode = 1;
    for (const c of manifest.cases)
      if (!artifacts.has(c.id))
        save({
          caseId: c.id,
          status: "failed",
          elapsedMs: 0,
          events: [],
          error: `Preflight: ${metadata.error}`,
        });
    console.error(`[Eval] ${metadata.error}`);
  } finally {
    metadata.finishedAt = new Date().toISOString();
    write(path.join(dir, "run.json"), metadata);
    // No worker is started. Bound shutdown even if a Redis endpoint is absent.
    if (queues) await Promise.all(queues.map((q: any) => q.disconnect()));
    if (redis)
      for (const client of [
        redis.cacheRedisClient,
        redis.queueConnection,
        redis.coordinationRedisClient,
      ])
        client.disconnect();
    if (pool) await pool.end();
  }
  saveScores(dir);
  console.log(
    `Saved ${dir}. Edit adjudications.json, then run: npm run eval:review -- score ${label}`,
  );
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  return message
    .replace(/(?:https?|postgres(?:ql)?|redis):\/\/[^\s]+/gi, "[redacted URL]")
    .slice(0, 1000);
}

function compare(beforeLabel: string, afterLabel: string) {
  const before = saveScores(runDir(beforeLabel));
  const afterDir = runDir(afterLabel);
  const after = saveScores(afterDir);
  if (before.run.datasetHash !== after.run.datasetHash)
    throw new Error("Cannot compare different dataset versions/content");
  const warnings: string[] = [];
  for (const key of ["model", "index", "budget", "cachePolicy", "machine"])
    if (hash(before.run[key]) !== hash(after.run[key]))
      warnings.push(
        `${key} differs; interpret performance/quality changes with this confounder`,
      );
  if (!before.summary.finalized || !after.summary.finalized)
    warnings.push(
      "Quality comparison pending manual adjudication or failed cases; no quality delta claimed",
    );
  const delta = (a: number | null | undefined, b: number | null | undefined) =>
    a == null || b == null ? null : b - a;
  const cases = after.summary.cases.map((next) => {
    const prev = before.summary.cases.find((c) => c.caseId === next.caseId)!;
    return {
      caseId: next.caseId,
      beforeStatus: prev.status,
      afterStatus: next.status,
      quality:
        prev.finalized && next.finalized
          ? {
              before: prev.metrics,
              after: next.metrics,
              newlyMissed: next.missed.filter(
                (m) => !prev.missed.some((p) => p.bugId === m.bugId),
              ),
              recovered: prev.missed.filter(
                (m) => !next.missed.some((p) => p.bugId === m.bugId),
              ),
            }
          : null,
      evidence: Object.fromEntries(
        stages.map((s) => [
          s,
          { before: prev.coverage[s], after: next.coverage[s] },
        ]),
      ),
      latencyDeltaMs:
        prev.status === "complete" && next.status === "complete"
          ? next.elapsedMs - prev.elapsedMs
          : null,
      inputTokenDelta: delta(prev.usage.inputTokens, next.usage.inputTokens),
      outputTokenDelta: delta(prev.usage.outputTokens, next.usage.outputTokens),
    };
  });
  write(path.join(afterDir, "comparison.json"), {
    before: beforeLabel,
    after: afterLabel,
    warnings,
    cases,
  });
  fs.writeFileSync(
    path.join(afterDir, "comparison.md"),
    [
      `# ${beforeLabel} → ${afterLabel}`,
      "",
      ...warnings.map((w) => `- ${w}`),
      "",
      "| Case | Quality TP/FP/FN before → after | Latency delta (ms) | Input/output token delta |",
      "| --- | --- | --- | --- |",
      ...cases.map(
        (c) =>
          `| ${c.caseId} | ${c.quality ? `${c.quality.before!.tp}/${c.quality.before!.fp}/${c.quality.before!.fn} → ${c.quality.after!.tp}/${c.quality.after!.fp}/${c.quality.after!.fn}` : "pending"} | ${c.latencyDeltaMs ?? "unknown"} | ${c.inputTokenDelta ?? "unknown"} / ${c.outputTokenDelta ?? "unknown"} |`,
      ),
      "",
      "Stage-by-stage evidence and newly missed/recovered bugs are in comparison.json.",
      "",
    ].join("\n"),
  );
  console.log(`Comparison saved in ${afterDir}`);
}

try {
  if (args[0] === "run") await run(args[1]);
  else if (args[0] === "score") {
    const { summary } = saveScores(runDir(args[1]));
    console.log(
      JSON.stringify(
        {
          finalized: summary.finalized,
          aggregate: summary.aggregate,
          completed: summary.completed,
          total: summary.total,
        },
        null,
        2,
      ),
    );
  } else if (args[0] === "compare") compare(args[1], args[2]);
  else {
    console.log(
      "Usage: npm run eval:review -- run <label> [--repository-id UUID] [--clerk-user-id ID] [--manifest FILE] [--pricing FILE]\n       npm run eval:review -- score <label>\n       npm run eval:review -- compare <baseline> <new>",
    );
    if (args.length && args[0] !== "--help") process.exitCode = 1;
  }
} catch (error) {
  console.error(`[Eval] ${safeMessage(error)}`);
  process.exitCode = 1;
}
