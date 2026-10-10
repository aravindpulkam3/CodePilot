import { createHash } from "node:crypto";
import { stripChunkHeader } from "../../src/shared/prompts/sourceRefs.js";
import type { DiagnosticEvent } from "../../src/shared/utils/diagnostics.js";

export const stages = ["initial", "selected", "verified", "prompt"] as const;
export type Requirement = {
  file: string;
  symbol?: string;
  requiredSource: string[];
  reason: string;
};
export interface PilotCase {
  id: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  prTitle: string;
  prDescription: string | null;
  snapshotHash: string;
  expectedFindings: Array<{
    id: string;
    file: string;
    lineStart: number;
    lineEnd: number;
    rootCause: string;
    trigger: string;
    consequence: string;
    evidence: string;
    acceptableAnchorPaths: string[];
  }>;
  requiredContext: Requirement[];
  safeRationale?: string;
}
export interface Manifest {
  version: number;
  githubRepository: string;
  expectedIndexSha: string;
  cases: PilotCase[];
}
export interface Artifact {
  caseId: string;
  status: "complete" | "failed" | "invalid";
  error?: string;
  elapsedMs: number;
  events: DiagnosticEvent[];
  indexBefore?: unknown;
  indexAfter?: unknown;
}
export type Disposition =
  | "matched"
  | "false_positive"
  | "duplicate"
  | "valid_unexpected"
  | "non_bug"
  | "unresolved";
export interface Classification {
  findingId: string;
  disposition: Disposition;
  expectedBugId: string | null;
  duplicateOf: string | null;
  rootCauseConfirmed: boolean;
  triggerOrConsequenceConfirmed: boolean;
  locationConfirmed: boolean;
  notes: string;
}
export interface Adjudication {
  artifactHash: string;
  confirmed: boolean;
  findings: Classification[];
}

export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function snapshotHash(snapshot: any) {
  return hash({
    title: snapshot.title,
    description: snapshot.description ?? null,
    files: snapshot.files.map((f: any) => ({
      filename: f.filename,
      previous_filename: f.previous_filename ?? null,
      status: f.status,
      additions: f.additions ?? null,
      deletions: f.deletions ?? null,
      patch: f.patch || "",
    })),
  });
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function validateManifest(value: any): asserts value is Manifest {
  check(
    Number.isInteger(value.version) &&
      value.version > 0 &&
      /^[\w.-]+\/[\w.-]+$/.test(value.githubRepository),
    "Invalid manifest identity",
  );
  const sha = /^[a-f0-9]{40}$/;
  check(
    sha.test(value.expectedIndexSha) &&
      Array.isArray(value.cases) &&
      value.cases.length > 0,
    "Invalid manifest revisions/cases",
  );
  const ids = new Set();
  const pulls = new Set();
  for (const c of value.cases) {
    check(
      typeof c.id === "string" && /^[a-z0-9-]+$/.test(c.id) && !ids.has(c.id),
      "Invalid/duplicate case ID",
    );
    ids.add(c.id);
    check(
      Number.isInteger(c.pullNumber) &&
        c.pullNumber > 0 &&
        !pulls.has(c.pullNumber),
      "Invalid/duplicate PR number",
    );
    pulls.add(c.pullNumber);
    check(
      sha.test(c.headSha) &&
        sha.test(c.baseSha) &&
        /^[a-f0-9]{64}$/.test(c.snapshotHash),
      "Missing pinned revision or snapshot hash",
    );
    check(
      Array.isArray(c.expectedFindings) && Array.isArray(c.requiredContext),
      "Missing expectations",
    );
    const bugs = new Set();
    for (const b of c.expectedFindings) {
      check(typeof b.id === "string" && !bugs.has(b.id), "Duplicate bug ID");
      bugs.add(b.id);
      for (const key of [
        "file",
        "rootCause",
        "trigger",
        "consequence",
        "evidence",
      ])
        check(
          typeof b[key] === "string" && b[key].trim(),
          `Missing bug ${key}`,
        );
      check(
        Array.isArray(b.acceptableAnchorPaths) &&
          b.acceptableAnchorPaths.length,
        "Missing accepted locations",
      );
    }
    check(
      c.expectedFindings.length || typeof c.safeRationale === "string",
      "Safe case needs a rationale",
    );
    for (const r of c.requiredContext) {
      check(
        typeof r.file === "string" &&
          !r.file.startsWith("/") &&
          !r.file.includes("..") &&
          !r.file.includes("\\"),
        "Invalid context path",
      );
      check(
        Array.isArray(r.requiredSource) &&
          r.requiredSource.length &&
          r.requiredSource.every((s: any) => typeof s === "string" && s.trim()),
        "Source fragments required",
      );
    }
  }
}
export function assertSnapshot(c: PilotCase, snapshot: any) {
  check(
    snapshot.head_sha === c.headSha && snapshot.base_sha === c.baseSha,
    "EVAL_PR_REVISION_DRIFT",
  );
  check(snapshotHash(snapshot) === c.snapshotHash, "EVAL_PR_SNAPSHOT_DRIFT");
}
export function assertIndex(index: any, expectedSha: string) {
  check(
    index?.indexing_status === "READY" &&
      index.last_indexed_sha === expectedSha,
    "EVAL_INDEX_NOT_READY_OR_WRONG_SHA",
  );
  check(
    index.chunks > 0 &&
      index.revisions?.length === 1 &&
      index.revisions[0] === expectedSha,
    "EVAL_INDEX_CONTENT_REVISION_MISMATCH",
  );
}
export function assertIndexUnchanged(
  before: any,
  after: any,
  expectedSha: string,
) {
  assertIndex(after, expectedSha);
  check(hash(before) === hash(after), "EVAL_INDEX_CHANGED");
}
export const event = (a: Artifact, stage: string) =>
  a.events.find((e) => e.stage === stage)?.data;
export const findings = (a: Artifact): any[] =>
  event(a, "validated")?.findings ?? [];
export function newAdjudication(a: Artifact): Adjudication {
  return {
    artifactHash: hash(a),
    confirmed: false,
    findings: findings(a).map((_, i) => ({
      findingId: `f${i + 1}`,
      disposition: "unresolved",
      expectedBugId: null,
      duplicateOf: null,
      rootCauseConfirmed: false,
      triggerOrConsequenceConfirmed: false,
      locationConfirmed: false,
      notes: "",
    })),
  };
}

// Exact paths plus source text, never path mentions or synthetic headers. A
// requirement may span multiple chunks; each fragment must occur intact in one.
export function evidenceCoverage(c: PilotCase, a: Artifact) {
  const synthetic = (chunk: any) =>
    chunk.symbolType === "class_skeleton" ||
    (chunk.content?.startsWith("// File: ") &&
      /^\/\/ Type: class_skeleton\r?$/m.test(chunk.content));
  const verified = event(a, "verified");
  return Object.fromEntries(
    stages.map((stage) => {
      const data = event(a, stage);
      const chunks = [...(data?.codeChunks ?? []), ...(data?.docChunks ?? [])];
      if (stage === "prompt") {
        for (const file of data?.enclosing?.files ?? [])
          for (const chunk of file.chunks) {
            if (chunk.symbolType !== "class_skeleton")
              chunks.push({
                ...chunk,
                filePath: file.filename,
                symbolName: chunk.qualifiedName ?? chunk.symbolName,
                commitSha: c.headSha,
              });
          }
      }
      const requirements = c.requiredContext.map((r) => {
        const eligible = chunks.filter(
          (ch) =>
            ch.filePath === r.file &&
            !synthetic(ch) &&
            // Final code has stripped headers; recover the synthetic flag from the
            // saved, head-verified chunk with the same full retrieval identity.
            !(
              stage === "prompt" &&
              ch.contentHash &&
              (verified?.codeChunks ?? []).some(
                (original: any) =>
                  original.filePath === ch.filePath &&
                  original.commitSha === ch.commitSha &&
                  original.contentHash === ch.contentHash &&
                  synthetic(original),
              )
            ) &&
            (stage === "initial" ||
              stage === "selected" ||
              ch.commitSha === c.headSha),
        );
        const missingFragments = r.requiredSource.filter(
          (source) =>
            !eligible.some((ch) =>
              stripChunkHeader(ch.content).includes(source),
            ),
        );
        // Symbols help locate the relevant chunk; full-source fragments are the
        // decisive check, since split parts and whole-file fallbacks rename symbols.
        return {
          file: r.file,
          symbol: r.symbol ?? null,
          matched: Boolean(data) && missingFragments.length === 0,
          missingFragments,
          evidence: eligible.map((ch) => ({
            filePath: ch.filePath,
            symbolName: ch.symbolName,
            commitSha: ch.commitSha,
            contentHash: ch.contentHash ?? hash(ch.content),
            lineStart: ch.lineStart ?? ch.startLine,
            lineEnd: ch.lineEnd ?? ch.endLine,
          })),
        };
      });
      return [
        stage,
        {
          captured: Boolean(data),
          matched: requirements.filter((r) => r.matched).length,
          total: requirements.length,
          rate:
            data && requirements.length
              ? requirements.filter((r) => r.matched).length /
                requirements.length
              : null,
          requirements,
        },
      ];
    }),
  ) as Record<
    (typeof stages)[number],
    {
      captured: boolean;
      matched: number;
      total: number;
      rate: number | null;
      requirements: any[];
    }
  >;
}
export function metrics(tp: number, fp: number, fn: number) {
  return {
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    f1: 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : null,
  };
}
export function scoreCase(
  c: PilotCase,
  a: Artifact,
  adjudication?: Adjudication,
) {
  const coverage = evidenceCoverage(c, a);
  const actual = findings(a);
  const pending = {
    caseId: c.id,
    status: a.status,
    finalized: false,
    metrics: null,
    coverage,
    missed: [] as any[],
    falseAlarms: null as number | null,
    classifications: {} as Record<string, number>,
  };
  if (a.status !== "complete") return pending;
  check(
    adjudication && adjudication.artifactHash === hash(a),
    `Missing/stale adjudication: ${c.id}`,
  );
  check(
    adjudication.findings.length === actual.length,
    `Finding count changed: ${c.id}`,
  );
  const ids = new Set<string>();
  const matched = new Set<string>();
  const allowed = [
    "matched",
    "false_positive",
    "duplicate",
    "valid_unexpected",
    "non_bug",
    "unresolved",
  ];
  for (const f of adjudication.findings) {
    check(
      /^f[1-9]\d*$/.test(f.findingId) &&
        Number(f.findingId.slice(1)) <= actual.length &&
        !ids.has(f.findingId),
      "Invalid/duplicate finding ID",
    );
    ids.add(f.findingId);
    check(allowed.includes(f.disposition), "Invalid disposition");
    pending.classifications[f.disposition] =
      (pending.classifications[f.disposition] ?? 0) + 1;
    if (f.disposition === "matched") {
      const bug = c.expectedFindings.find((b) => b.id === f.expectedBugId);
      check(
        bug && !matched.has(bug.id),
        "Unknown bug or multiple true-positive credits",
      );
      check(
        f.rootCauseConfirmed === true &&
          f.triggerOrConsequenceConfirmed === true &&
          f.locationConfirmed === true &&
          f.notes.trim(),
        "A match requires documented root cause, trigger/consequence and location confirmation",
      );
      check(
        bug.acceptableAnchorPaths.includes(
          actual[Number(f.findingId.slice(1)) - 1].file_path,
        ),
        "Finding location is outside verified acceptable paths",
      );
      matched.add(bug.id);
    } else if (f.disposition !== "unresolved")
      check(
        typeof f.notes === "string" && f.notes.trim(),
        "Final classifications require a reason",
      );
    if (f.disposition === "duplicate") {
      const original = adjudication.findings.find(
        (x) => x.findingId === f.duplicateOf,
      );
      check(
        original &&
          original.findingId !== f.findingId &&
          ["matched", "false_positive", "valid_unexpected", "non_bug"].includes(
            original.disposition,
          ),
        "Duplicate must reference a resolved nonduplicate finding",
      );
    }
  }
  // Unexpected valid defects indicate incomplete ground truth. They remain
  // visible, receive no false-positive penalty, and hold final metrics pending.
  if (
    adjudication.confirmed !== true ||
    pending.classifications.unresolved ||
    pending.classifications.valid_unexpected
  )
    return pending;
  const missed = c.expectedFindings
    .filter((bug) => !matched.has(bug.id))
    .map((bug) => {
      const file = event(a, "request")?.reviewInput?.files?.find(
        (f: any) => f.filename === bug.file,
      );
      const changePresent = file?.hunks?.some(
        (h: any) =>
          h.included &&
          h.newLines > 0 &&
          h.newStart <= bug.lineEnd &&
          h.newStart + h.newLines > bug.lineStart,
      );
      let diagnosis: string;
      if (!changePresent) diagnosis = "changed_source_omitted";
      else if (stages.some((s) => !coverage[s].captured))
        diagnosis = "diagnostics_incomplete";
      else if (
        c.requiredContext.length &&
        coverage.prompt.matched < coverage.prompt.total
      ) {
        const firstLoss = stages.find(
          (s) => coverage[s].matched < coverage[s].total,
        )!;
        diagnosis = {
          initial: "required_context_not_discovered",
          selected: "lost_during_retrieval_selection",
          verified: "lost_during_head_verification",
          prompt: "lost_during_prompt_budgeting",
        }[firstLoss];
      } else {
        // With no specified cross-file requirements, only claim model-visible
        // changed code. Completeness of the manifest is still a human assumption.
        diagnosis = "missed_despite_declared_evidence_present";
      }
      return {
        bugId: bug.id,
        diagnosis,
        note: "Evidence availability does not prove model understanding; inspect saved source and prompt.",
      };
    });
  const fp = pending.classifications.false_positive ?? 0;
  return {
    ...pending,
    finalized: true,
    metrics: metrics(matched.size, fp, missed.length),
    missed,
    falseAlarms: c.expectedFindings.length ? null : fp,
  };
}

export interface Pricing {
  model: string;
  currency: "USD";
  sourceUrl: string;
  effectiveDate: string;
  inputPerMillion: number;
  outputPerMillion: number;
  billing: "uncached-text-no-thinking";
}
export function estimateCost(provider: any, pricing?: Pricing) {
  const usage = provider?.usage;
  if (provider?.provider === "ollama")
    return {
      generationApiUsd: 0,
      basis: "Local Ollama; hardware/electricity excluded",
      totalPipelineUsd: null,
      embeddingUsd: null,
    };
  const valid =
    pricing &&
    pricing.model === provider?.model &&
    pricing.currency === "USD" &&
    /^https:\/\//.test(pricing.sourceUrl) &&
    /^\d{4}-\d{2}-\d{2}$/.test(pricing.effectiveDate) &&
    pricing.billing === "uncached-text-no-thinking" &&
    [pricing.inputPerMillion, pricing.outputPerMillion].every(
      (n) => Number.isFinite(n) && n >= 0,
    ) &&
    [usage?.inputTokens, usage?.outputTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) &&
    !usage?.metadata?.cachedContentTokenCount &&
    !usage?.metadata?.thoughtsTokenCount &&
    !usage?.metadata?.toolUsePromptTokenCount;
  return {
    generationApiUsd: valid
      ? (usage.inputTokens * pricing!.inputPerMillion +
          usage.outputTokens * pricing!.outputPerMillion) /
        1e6
      : null,
    basis: valid
      ? pricing
      : "Unknown usage/pricing or unsupported billing components",
    totalPipelineUsd: null,
    embeddingUsd: null,
  };
}

export function summarize(
  manifest: Manifest,
  artifacts: Artifact[],
  adjudications: Record<string, Adjudication>,
  pricing?: Pricing,
) {
  check(
    artifacts.length === manifest.cases.length &&
      new Set(artifacts.map((a) => a.caseId)).size === artifacts.length,
    "Incomplete/duplicate case artifacts",
  );
  const cases = manifest.cases.map((c) => {
    const a = artifacts.find((a) => a.caseId === c.id);
    check(a, `Missing artifact: ${c.id}`);
    return {
      ...scoreCase(c, a, adjudications[c.id]),
      error: a.error ?? null,
      elapsedMs: a.elapsedMs,
      usage: event(a, "provider")?.usage ?? {
        inputTokens: null,
        outputTokens: null,
      },
      cost: estimateCost(event(a, "provider"), pricing),
      timing: event(a, "timing") ?? null,
      generationAttempts: a.events.filter(e => e.stage === "generationAttempt").map(e => e.data),
      budget: event(a, "request")?.reviewInput?.budget ?? null,
      findings: findings(a).map((f, i) => ({ findingId: `f${i + 1}`, ...f })),
    };
  });
  const finalized = cases.every((c) => c.finalized);
  const sums = cases.reduce(
    (s, c) => ({
      tp: s.tp + (c.metrics?.tp ?? 0),
      fp: s.fp + (c.metrics?.fp ?? 0),
      fn: s.fn + (c.metrics?.fn ?? 0),
    }),
    { tp: 0, fp: 0, fn: 0 },
  );
  const tokenTotal = (key: string) =>
    cases.every((c) => Number.isSafeInteger(c.usage[key]) && c.usage[key] >= 0)
      ? cases.reduce((sum, c) => sum + c.usage[key], 0)
      : null;
  return {
    datasetVersion: manifest.version,
    finalized,
    completed: cases.filter((c) => c.status === "complete").length,
    total: cases.length,
    aggregate: finalized ? metrics(sums.tp, sums.fp, sums.fn) : null,
    usage: {
      inputTokens: tokenTotal("inputTokens"),
      outputTokens: tokenTotal("outputTokens"),
    },
    totalLatencyMs: cases.reduce((sum, c) => sum + c.elapsedMs, 0),
    cases,
  };
}
export function markdown(summary: ReturnType<typeof summarize>) {
  const show = (v: unknown) =>
    v == null
      ? "unknown / pending"
      : typeof v === "number"
        ? Number(v.toFixed(3))
        : String(v).replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = [
    "# PR review evaluation",
    "",
    `Completed ${summary.completed}/${summary.total}; finalized: ${summary.finalized}. Dataset v${summary.datasetVersion}.`,
    "",
    "Metrics remain pending until every successful case is confirmed and every finding is resolved. Failed/invalid cases do not count as clean reviews.",
    "",
    "| Case | State | TP / FP / FN | Precision / recall / F1 | Context initial → selected → verified → prompt | Seconds | Input / output tokens |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const c of summary.cases)
    lines.push(
      `| ${c.caseId} | ${c.status}${c.finalized ? "" : " / pending"} | ${c.metrics ? `${c.metrics.tp} / ${c.metrics.fp} / ${c.metrics.fn}` : "pending"} | ${c.metrics ? [c.metrics.precision, c.metrics.recall, c.metrics.f1].map(show).join(" / ") : "pending"} | ${stages.map((s) => (c.coverage[s].total ? `${c.coverage[s].matched}/${c.coverage[s].total}${c.coverage[s].captured ? "" : " (not captured)"}` : "n/a")).join(" → ")} | ${show(c.elapsedMs / 1000)} | ${show(c.usage.inputTokens)} / ${show(c.usage.outputTokens)} |`,
    );
  lines.push(
    "",
    `Aggregate: ${summary.aggregate ? JSON.stringify(summary.aggregate) : "pending"}`,
    `Actual token totals: ${JSON.stringify(summary.usage)}.`,
    "",
    `Total review wall time: ${(summary.totalLatencyMs / 1000).toFixed(2)} seconds.`,
    "",
    "Latency covers acquisition through validation/final revision check and evaluation index checks. Initial indexing, publication and human scoring are excluded. UTF-8 budget estimates are not measured usage. Query embedding, setup and hardware costs are unmeasured; total pipeline cost is unknown.",
    "",
  );
  for (const c of summary.cases) {
    lines.push(
      `## ${c.caseId}`,
      "",
      `Error: ${c.error ? show(c.error) : "none"}. Safe-case false alarms: ${show(c.falseAlarms)}.`,
      `Budget estimate: ${show(c.budget?.estimatedInputTokens)} (${c.budget?.method ?? "unknown"}). Generation API cost: ${show(c.cost.generationApiUsd)} USD.`,
      `Generation attempts: ${c.generationAttempts.length || 'not recorded (older run or generation not reached)'}. Recorded retry waits: ${c.generationAttempts.reduce((sum, a) => sum + a.delayMs, 0)} ms. Failed-attempt token usage is unknown; displayed usage covers the returned response only.`,
      "",
    );
    for (const [stage, cov] of Object.entries(c.coverage))
      for (const r of cov.requirements) {
        lines.push(
          `- ${stage}: ${r.file}: ${r.matched ? "present" : "missing"}${r.missingFragments.length ? ` — ${r.missingFragments.map((s: string) => "`" + s + "`").join(", ")}` : ""}`,
        );
      }
    for (const f of c.findings)
      lines.push(
        `- ${f.findingId}: ${f.file_path}:${f.line_number ?? "file"} — ${f.title}: ${f.description}`,
      );
    for (const m of c.missed)
      lines.push(`- Missed ${m.bugId}: ${m.diagnosis}. ${m.note}`);
    lines.push("");
  }
  return lines.join("\n");
}
