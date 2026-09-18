/**
 * Minimal retrieval regression check. Not a framework: one fixed case file,
 * one output folder per run, one hit-rate number per case.
 *
 *   npx tsx scripts/evalRetrieval.ts --out baseline
 *   npx tsx scripts/evalRetrieval.ts --out new
 *   npx tsx scripts/evalRetrieval.ts --compare baseline new
 *
 * Needs Postgres and both Redis instances running, and GEMINI_API_KEY for
 * query embeddings. Never enqueues a sync (skipSync / isNewSession:false)
 * and never calls a generation LLM — it records what WOULD be sent.
 *
 * Evidence matching uses repository-relative paths (exact, or as a path
 * suffix), never bare basenames, so index.ts / config.ts can't false-match.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/config/db.js";
import { RepositoryContextProvider } from "../src/features/chat/providers/repositoryContext.provider.js";
import { reviewService } from "../src/features/review/review.service.js";
import { findRepositoryById } from "../src/features/repository/repository.service.js";
import { retrievalService } from "../src/infrastructure/retrieval/retreival.service.js";
import { interviewPromptBuilder } from "../src/features/interview/interviewPromptBuilder.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(HERE, "eval-out");

type Case = Record<string, any> & { id: string; mode: string };

const pathMatches = (retrieved: string, expected: string) =>
  retrieved === expected || retrieved.endsWith("/" + expected);

function hitRate(expected: string[] | undefined, retrievedPaths: string[]) {
  if (!expected || expected.length === 0) return null;
  const matched = expected.filter((e) =>
    retrievedPaths.some((r) => pathMatches(r, e)),
  );
  return {
    matched,
    missing: expected.filter((e) => !matched.includes(e)),
    rate: matched.length / expected.length,
  };
}

const userPromptOf = (messages: { role: string; content: string }[]) =>
  messages
    .filter((m) => m.role !== "assistant")
    .map((m) => `### ${m.role}\n${m.content}`)
    .join("\n\n");

async function runQA(c: Case, repositoryId: string) {
  const provider = new RepositoryContextProvider();
  const session: any = {
    id: "eval",
    user_id: "eval",
    type: "REPO_QA",
    repository_id: repositoryId,
    status: "active",
    created_at: "",
    updated_at: "",
  };
  const payload = await provider.buildContext(session, c.question, "eval", {
    isNewSession: false,
    recentHistory: [],
  });
  const items = payload.promptContext?.items ?? [];
  const evidence = items.filter(
    (i) => i.filePath && (i.kind === "code" || i.kind === "documentation"),
  );
  return {
    retrieved: evidence.map((i) => ({
      kind: i.kind,
      filePath: i.filePath,
      symbol: i.symbol ?? i.section,
      lines: i.lineStart ? `${i.lineStart}-${i.lineEnd}` : undefined,
      truncated: i.truncated,
    })),
    background: items
      .filter(
        (i) =>
          !(i.filePath && (i.kind === "code" || i.kind === "documentation")),
      )
      .map((i) => ({
        kind: i.kind,
        title: i.title,
        summaryLevel: i.summaryLevel,
        filePath: i.filePath,
        displayable: i.displayable,
        chars: i.body.length,
      })),
    hit: hitRate(
      c.expectedEvidence,
      evidence.map((i) => i.filePath!),
    ),
    prompt: payload.systemPrompt,
  };
}

function readFixture(file: string) {
  return fs.readFileSync(path.join(HERE, "eval-fixtures", file), "utf8");
}

function checkEnclosing(c: Case, changedCode: any) {
  if (!changedCode) return null;
  const byFile = Object.fromEntries(
    (changedCode.files ?? []).map((f: any) => [f.filename, f]),
  );
  const checks = Object.entries(
    (c.expectedEnclosing ?? {}) as Record<string, string[]>,
  ).map(([file, names]) => {
    const f = byFile[file];
    const attached: string[] = (f?.chunks ?? []).map(
      (ch: any) => ch.qualifiedName ?? ch.symbolName,
    );
    return {
      file,
      coverage: f?.coverage ?? "(not processed)",
      expectedCoverage: c.expectedCoverage?.[file],
      attached,
      // Every expected name must be attached, and nothing unrelated may be.
      ok:
        names.every((n) => attached.includes(n)) &&
        attached.every((a) => names.includes(a)) &&
        (!c.expectedCoverage?.[file] ||
          f?.coverage === c.expectedCoverage[file]),
    };
  });
  return {
    fullyHeadCoveredFiles: changedCode.fullyHeadCoveredFiles,
    checks,
    ok: checks.every((x) => x.ok),
  };
}

async function runReview(c: Case, repositoryId: string) {
  const prInput = {
    title: c.title,
    description: null,
    head_sha: c.headSha,
    files: c.files.map((f: any) => ({
      filename: f.filename,
      status: f.status,
      patch: readFixture(f.patchFile),
    })),
  };

  if (c.headOnly) {
    const mod: any =
      await import("../src/features/review/changedCodeContext.js").catch(
        () => null,
      );
    const reviewMod: any =
      await import("../src/features/review/review.service.js");
    if (!mod || !reviewMod.githubChangedCodeDeps)
      return {
        skipped: "PR-head enclosing code does not exist in this version",
      };
    const [owner, repo] = c.githubRepo.split("/");
    const changedCode = await mod.buildChangedCodeContext(
      { headSha: c.headSha, files: prInput.files },
      reviewMod.githubChangedCodeDeps(owner, repo, undefined),
    );
    return { changedCode, enclosing: checkEnclosing(c, changedCode) };
  }

  const repoDetails = await findRepositoryById(repositoryId);
  if (!repoDetails) throw new Error(`repository ${repositoryId} not found`);
  const out: any = await reviewService.buildReviewMessages(
    "eval",
    repositoryId,
    repoDetails,
    prInput as any,
    { skipSync: true, githubToken: undefined } as any,
  );
  const chunks = out.retrievedContext.codeChunks;
  return {
    retrieved: chunks.map((ch: any) => ({
      class: ch.symbolType,
      filePath: ch.filePath,
      symbol: ch.symbolName,
      lines: `${ch.lineStart}-${ch.lineEnd}`,
    })),
    docs: (out.retrievedContext.docChunks ?? []).map(
      (d: any) => `${d.filePath} § ${d.sectionPath}`,
    ),
    changedCode: out.changedCode ?? null,
    enclosing: checkEnclosing(c, out.changedCode),
    hit: hitRate(
      c.expectedEvidence,
      chunks.map((ch: any) => ch.filePath),
    ),
    prompt: userPromptOf(out.messages),
  };
}

async function runInterviewStart(c: Case, repositoryId: string) {
  const ctx: any = await retrievalService.retrieveInterviewStartContext(
    "eval",
    repositoryId,
    undefined,
    { skipSync: true },
  );
  const config: any = {
    mode: "repository",
    repositoryId,
    difficulty: "medium",
    followUpsEnabled: true,
  };
  const messages = interviewPromptBuilder.buildStartPrompt(config, ctx);
  return {
    modules: (ctx.moduleInventory ?? []).map(
      (m: any) => `${m.module} (${m.fileCount})`,
    ),
    docs: (ctx.docChunks ?? []).map(
      (d: any) => `${d.filePath} § ${d.sectionPath}`,
    ),
    // Before the change: READY-gated LLM summaries. After: the deterministic profile.
    orientation: {
      repositoryProfileChars:
        typeof ctx.repositoryProfile === "string"
          ? ctx.repositoryProfile.length
          : null,
      repositorySummary: ctx.repository ? "summary" : null,
      architectureSummary: ctx.architecture ? "summary" : null,
    },
    prompt: userPromptOf(messages),
  };
}

async function runInterviewFollowUp(c: Case, repositoryId: string) {
  const state: any = {
    currentTopic: "",
    topicsCovered: [],
    currentFocus: c.focus,
    visitedFiles: [],
    visitedModules: [],
    turnsOnCurrentFocus: 1,
    turnsOnCurrentModule: 1,
    lastAction: "FOLLOW_UP",
    difficulty: "medium",
    difficultyMode: "medium",
    knownGaps: [],
    questionCount: 2,
  };
  const ctx: any = await retrievalService.retrieveInterviewFollowUpContext(
    repositoryId,
    c.question,
    state,
  );
  const messages = interviewPromptBuilder.buildFollowUpPrompt(
    state,
    [{ role: "assistant", content: c.question }],
    ctx,
  );
  const code = [...(ctx.groundingCode ?? []), ...(ctx.stayCode ?? [])];
  return {
    granularity: ctx.granularity,
    grounding: (ctx.groundingCode ?? []).map(
      (x: any) => `${x.filePath}:${x.lineStart}-${x.lineEnd}`,
    ),
    stay: (ctx.stayCode ?? []).map(
      (x: any) => `${x.filePath}:${x.lineStart}-${x.lineEnd}`,
    ),
    docs: (ctx.groundingDocs ?? []).map(
      (d: any) => `${d.filePath} § ${d.sectionPath}`,
    ),
    hasSummaryOrProfile: Boolean(ctx.groundingSummary || ctx.staySummary),
    hit: hitRate(
      c.expectedEvidence,
      code.map((x: any) => x.filePath),
    ),
    prompt: userPromptOf(messages),
  };
}

async function runAll(label: string) {
  const spec = JSON.parse(
    fs.readFileSync(path.join(HERE, "evalCases.json"), "utf8"),
  );
  const dir = path.join(OUT_ROOT, label);
  fs.mkdirSync(dir, { recursive: true });
  const summary: Record<string, any> = {};

  for (const c of spec.cases as Case[]) {
    const runners: Record<string, (c: Case, r: string) => Promise<any>> = {
      qa: runQA,
      review: runReview,
      "interview-start": runInterviewStart,
      "interview-followup": runInterviewFollowUp,
    };
    let result: any;
    try {
      result = await runners[c.mode](c, spec.repositoryId);
    } catch (err: any) {
      result = { error: String(err?.message ?? err) };
    }
    fs.writeFileSync(
      path.join(dir, `${c.id}.json`),
      JSON.stringify({ case: c, ...result }, null, 2),
    );
    summary[c.id] = {
      mode: c.mode,
      manual: Boolean(c.manual),
      hitRate: result.hit?.rate ?? null,
      missing: result.hit?.missing ?? [],
      enclosingOk: result.enclosing?.ok ?? null,
      promptChars: result.prompt?.length ?? null,
      skipped: result.skipped ?? null,
      error: result.error ?? null,
    };
    const s = summary[c.id];
    console.log(
      `${c.id.padEnd(26)} ${c.mode.padEnd(19)} hit=${s.hitRate === null ? "  -  " : s.hitRate.toFixed(2)}` +
        ` enclosing=${s.enclosingOk === null ? "-" : s.enclosingOk} prompt=${s.promptChars ?? "-"}` +
        (s.missing.length ? ` missing=[${s.missing.join(", ")}]` : "") +
        (s.skipped ? ` SKIPPED: ${s.skipped}` : "") +
        (s.error ? ` ERROR: ${s.error}` : ""),
    );
  }
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(`\nWrote ${Object.keys(summary).length} case file(s) to ${dir}`);
}

function compare(a: string, b: string) {
  const load = (l: string) =>
    JSON.parse(fs.readFileSync(path.join(OUT_ROOT, l, "summary.json"), "utf8"));
  const before = load(a);
  const after = load(b);
  const fmt = (v: any) =>
    v === null || v === undefined
      ? "  -  "
      : typeof v === "number"
        ? v.toFixed(2)
        : String(v);
  for (const id of Object.keys(after)) {
    const x = before[id] ?? {};
    const y = after[id];
    const dropped =
      typeof x.hitRate === "number" &&
      typeof y.hitRate === "number" &&
      y.hitRate < x.hitRate;
    console.log(
      `${id.padEnd(26)} hit ${fmt(x.hitRate)} -> ${fmt(y.hitRate)}  enclosing ${fmt(x.enclosingOk)} -> ${fmt(y.enclosingOk)}` +
        `${y.manual ? "  (manual review)" : ""}${dropped ? "  <-- REGRESSION" : ""}${y.error ? `  ERROR: ${y.error}` : ""}`,
    );
  }
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const cmpIdx = args.indexOf("--compare");
try {
  if (cmpIdx >= 0) compare(args[cmpIdx + 1], args[cmpIdx + 2]);
  else if (outIdx >= 0) await runAll(args[outIdx + 1]);
  else console.log("usage: --out <label> | --compare <labelA> <labelB>");
} finally {
  await pool.end().catch(() => {});
  process.exit(0);
}
