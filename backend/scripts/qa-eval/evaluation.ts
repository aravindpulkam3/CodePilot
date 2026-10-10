import { createHash } from "node:crypto";
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface QACase {
  id: string; question: string; negativeCapability?: boolean;
  history?: { role: "user" | "assistant"; content: string }[];
  facts: { id: string; text: string }[];
  requiredContext: { id: string; path: string; fragments: string[] }[];
  verification: { test: string; sourceInspection: string[]; scope: string };
}
export interface Manifest { version: number; dataset: string; githubRepository: string; expectedIndexSha: string; cases: QACase[] }
export interface Artifact { caseId: string; status: string; answer: string; events: { stage: string; data: any }[]; elapsedMs: number; error?: string; [key: string]: any }
export const event = (a: Artifact, stage: string) => a.events.find(e => e.stage === stage)?.data;
export function validateManifest(m: Manifest) {
  if (m.version !== 1 || !/^[\da-f]{40}$/.test(m.expectedIndexSha) || !/^[\w.-]+\/[\w.-]+$/.test(m.githubRepository) || !m.cases?.length) throw new Error("Invalid Q&A manifest");
  const ids = new Set();
  for (const c of m.cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || ids.has(c.id) || !c.question?.trim() || !c.facts?.length || !c.requiredContext?.length) throw new Error("Invalid/duplicate case");
    ids.add(c.id);
    if (new Set(c.facts.map(f => f.id)).size !== c.facts.length || c.facts.some(f => !f.id || !f.text)) throw new Error("Invalid facts");
    if (c.history?.some(h => !["user", "assistant"].includes(h.role) || !h.content)) throw new Error("Invalid fixed history");
    if (new Set(c.requiredContext.map(e => e.id)).size !== c.requiredContext.length) throw new Error("Duplicate evidence ID");
    for (const e of c.requiredContext) if (!e.path || e.path.includes("..") || e.path.startsWith("/") || e.path.includes("\\") || !e.fragments.length || e.fragments.some(f => !f.trim())) throw new Error("Invalid evidence requirement");
  }
}
// Tree-sitter stores an export wrapper separately from its function body.
// Behavior evidence requires the actual declaration/body, not that wrapper.
const normalize = (s: string) => s.trim().replace(/^export\s+(?=(?:async\s+)?function\b)/, "").replace(/\s+/g, " ");
export function coverage(c: QACase, a: Artifact, sha: string) {
  const retrieved = event(a, "qa.retrieved");
  const request = event(a, "qa.request");
  const candidates = [...(retrieved?.codeChunks ?? []), ...(retrieved?.docChunks ?? [])]
    .filter(x => x.symbolType !== "class_skeleton" && !/\/\/ Type: class_skeleton/.test(x.content ?? ""))
    .map(x => ({ path: x.filePath, text: x.content, sha: x.commitSha }));
  const prompt = (request?.context?.promptContext?.items ?? [])
    .filter((x: any) => ["code", "documentation"].includes(x.kind) && x.symbolType !== "class_skeleton" && request.messages[0].content.includes(x.body))
    .map((x: any) => ({ path: x.filePath, text: x.body, sha: x.commitSha }));
  const has = (rows: any[], e: QACase["requiredContext"][number], fragment: string) => rows.some(x => x.path === e.path && x.sha === sha && normalize(x.text ?? "").includes(normalize(fragment)));
  return c.requiredContext.map(e => {
    const fragments = e.fragments.map(fragment => ({ fragment, retrieved: retrieved ? has(candidates, e, fragment) : null, prompt: request ? has(prompt, e, fragment) : null }));
    return { id: e.id, path: e.path, fragments,
      retrieved: retrieved ? fragments.every(f => f.retrieved) : null,
      prompt: request ? fragments.every(f => f.prompt) : null,
      indicator: !retrieved || !request ? "diagnostics incomplete" : fragments.some(f => !f.retrieved) ? "required evidence not returned by retrieval" : fragments.some(f => !f.prompt) ? "required evidence lost during prompt selection/budgeting" : "required evidence present in prompt",
    };
  });
}
export function citations(a: Artifact) {
  const items = event(a, "qa.request")?.context?.promptContext?.items ?? [];
  const result: any[] = [];
  for (const match of a.answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) for (const number of match[1].split(",")) {
    const n = Number(number), item = items.find((x: any) => x.n === n && x.displayable);
    result.push({ id: `c${result.length + 1}`, n, offset: match.index, resolves: !!item, source: item ?? null });
  }
  return result;
}
export function newAdjudication(c: QACase, a: Artifact) {
  return { artifactHash: hash(a), humanConfirmed: false, agentConfirmed: false, groundTruthConfirmed: false, reviewer: "", notes: "",
    facts: c.facts.map(f => ({ id: f.id, verdict: "unresolved", notes: "" })),
    additionalFactualErrors: { verdict: "unresolved", notes: "" },
    grounding: { verdict: "unresolved", notes: "" },
    citations: citations(a).map(x => ({ id: x.id, support: "unresolved", notes: "" })),
    citationCompleteness: { verdict: "unresolved", notes: "" },
    proposedClassification: null,
  };
}
const ratio = (n: number, d: number) => d ? n / d : null;
export function summarize(m: Manifest, artifacts: Artifact[], adjudications: Record<string, any>) {
  validateManifest(m);
  const results = m.cases.map(c => {
    const a = artifacts.find(x => x.caseId === c.id);
    if (!a) throw new Error(`Missing artifact ${c.id}`);
    const j = adjudications[c.id];
    if (!j || j.artifactHash !== hash(a)) throw new Error(`Adjudication/artifact mismatch: ${c.id}`);
    if (typeof j.humanConfirmed !== "boolean") throw new Error(`humanConfirmed must be boolean: ${c.id}`);
    if (j.agentConfirmed !== undefined && typeof j.agentConfirmed !== "boolean") throw new Error(`agentConfirmed must be boolean: ${c.id}`);
    if (j.humanConfirmed && j.agentConfirmed) throw new Error(`Ambiguous adjudication provenance: ${c.id}`);
    const adjudicator = j.humanConfirmed ? "human" : j.agentConfirmed ? "agent" : null;
    const evidence = coverage(c, a, m.expectedIndexSha), links = citations(a);
    let semantic: any = null;
    if (adjudicator) {
      if (a.status !== "complete" || j.groundTruthConfirmed !== true || !j.reviewer?.trim() || !j.notes?.trim()) throw new Error(`Adjudication verification incomplete: ${c.id}`);
      if (j.facts.length !== c.facts.length || j.facts.some((f: any, i: number) => f.id !== c.facts[i].id || !["correct", "incorrect", "missing"].includes(f.verdict) || !f.notes?.trim())) throw new Error(`Fact adjudication incomplete: ${c.id}`);
      if (!["none", "present"].includes(j.additionalFactualErrors?.verdict) || !j.additionalFactualErrors?.notes?.trim()) throw new Error(`Additional claims unchecked: ${c.id}`);
      for (const dimension of ["grounding", "citationCompleteness"]) if (!["supported", "partial", "unsupported", "not-applicable"].includes(j[dimension]?.verdict) || !j[dimension]?.notes?.trim()) throw new Error(`${dimension} unchecked: ${c.id}`);
      if (j.citations.length !== links.length || j.citations.some((v: any, i: number) => v.id !== links[i].id || !["supported", "unsupported"].includes(v.support) || !v.notes?.trim() || (v.support === "supported" && !links[i].resolves))) throw new Error(`Citation adjudication incomplete: ${c.id}`);
      const correctFacts = j.facts.filter((f: any) => f.verdict === "correct").length;
      semantic = { correctFacts, expectedFacts: c.facts.length, factualCoverage: ratio(correctFacts, c.facts.length),
        factuallyCorrect: correctFacts === c.facts.length && j.additionalFactualErrors.verdict === "none",
        grounding: j.grounding.verdict, supportedCitations: j.citations.filter((x: any) => x.support === "supported").length,
        citationCount: links.length, citationSupport: ratio(j.citations.filter((x: any) => x.support === "supported").length, links.length), citationCompleteness: j.citationCompleteness.verdict };
    }
    const allEvidence = evidence.every(e => e.prompt === true);
    return { id: c.id, question: c.question, expected: c.facts, answer: a.answer, status: a.status, error: a.error ?? null, evidence,
      embeddingQuery: event(a, "qa.retrieved")?.metadata?.embeddingQuery ?? null,
      usedConversationalBlend: event(a, "qa.retrieved")?.metadata?.usedConversationalBlend ?? null,
      semantic, adjudicator, assessment: semantic ? { reviewer: j.reviewer, notes: j.notes, facts: j.facts, additionalFactualErrors: j.additionalFactualErrors, grounding: j.grounding, citations: j.citations, citationCompleteness: j.citationCompleteness } : null,
      proposedClassification: j.proposedClassification ?? null, adjudication: semantic ? adjudicator === "human" ? "human confirmed" : "agent-adjudicated (user authorized)" : "pending confirmation",
      indicator: semantic && !semantic.factuallyCorrect && allEvidence ? "incorrect/incomplete answer despite declared evidence reaching model (diagnostic indicator, not proof of reasoning failure)" : evidence.map(e => e.indicator).filter((v, i, x) => x.indexOf(v) === i).join("; "),
      citations: { count: links.length, resolving: links.filter(x => x.resolves).length, resolutionRate: ratio(links.filter(x => x.resolves).length, links.length) },
      latencyMs: a.elapsedMs, retrievalMs: event(a, "qa.retrieved")?.elapsedMs ?? null,
      contextMs: event(a, "qa.request")?.contextMs ?? null, generationMs: event(a, "qa.response")?.generationMs ?? null,
      usage: event(a, "qa.usage") ?? null, cost: null,
      generationAttempts: a.events.filter(e => e.stage === "generationAttempt").map(e => e.data),
      retryWaitMs: a.events.filter(e => e.stage === "generationAttempt").reduce((n, e) => n + (e.data.delayMs ?? 0), 0),
      promptCharacters: event(a, "qa.request")?.messages?.reduce((n: number, x: any) => n + x.content.length, 0) ?? null,
      promptTokenEstimate: null,
    };
  });
  const confirmed = results.filter(x => x.semantic), evidence = results.flatMap(x => x.evidence);
  const sum = (key: string) => confirmed.reduce((n, x) => n + x.semantic[key], 0);
  const applicable = confirmed.filter(x => x.semantic.grounding !== "not-applicable");
  return { dataset: m.dataset, cases: results, aggregate: { total: results.length, complete: results.filter(x => x.status === "complete").length,
    confirmed: confirmed.length, humanConfirmed: confirmed.filter(x => x.adjudicator === "human").length, agentConfirmed: confirmed.filter(x => x.adjudicator === "agent").length, pending: results.length - confirmed.length,
    semanticScope: "Finalized adjudications only (human/agent provenance reported separately); null means unscored/no denominator. Retrieval is independent of semantic scoring.",
    correctFacts: sum("correctFacts"), expectedFacts: sum("expectedFacts"), fullyCorrectAnswers: confirmed.filter(x => x.semantic.factuallyCorrect).length,
    factualCoverage: ratio(sum("correctFacts"), sum("expectedFacts")), factuallyCorrectRate: ratio(confirmed.filter(x => x.semantic.factuallyCorrect).length, confirmed.length),
    fullyGroundedRate: ratio(applicable.filter(x => x.semantic.grounding === "supported").length, applicable.length),
    citationSupport: ratio(sum("supportedCitations"), sum("citationCount")),
    retrieval: { observed: evidence.filter(x => x.retrieved !== null).length, present: evidence.filter(x => x.retrieved === true).length, coverage: ratio(evidence.filter(x => x.retrieved === true).length, evidence.filter(x => x.retrieved !== null).length) },
    prompt: { observed: evidence.filter(x => x.prompt !== null).length, present: evidence.filter(x => x.prompt === true).length, coverage: ratio(evidence.filter(x => x.prompt === true).length, evidence.filter(x => x.prompt !== null).length) },
    totalMs: results.reduce((n, x) => n + x.latencyMs, 0),
    inputTokens: results.every(x => x.usage?.inputTokens != null) ? results.reduce((n, x) => n + x.usage.inputTokens, 0) : null,
    outputTokens: results.every(x => x.usage?.outputTokens != null) ? results.reduce((n, x) => n + x.usage.outputTokens, 0) : null,
  } };
}
export function compareSummaries(a: ReturnType<typeof summarize>, b: ReturnType<typeof summarize>) {
  const confirmedIds = (s: typeof a) => s.cases.filter(c => c.semantic).map(c => c.id);
  const sameConfirmedSubset = hash(confirmedIds(a)) === hash(confirmedIds(b));
  const semanticFields = ["factualCoverage", "factuallyCorrectRate", "fullyGroundedRate", "citationSupport"];
  const fields = ["complete", "confirmed", ...semanticFields, "totalMs", "inputTokens", "outputTokens"];
  const metrics = fields.map(key => {
    const before = (a.aggregate as any)[key], after = (b.aggregate as any)[key];
    return { metric: key, before, after, delta: before == null || after == null || (semanticFields.includes(key) && !sameConfirmedSubset) ? null : Number(after) - Number(before) };
  });
  return { sameConfirmedSubset, metrics, cases: a.cases.map(x => ({ id: x.id, before: x, after: b.cases.find(y => y.id === x.id) })) };
}
export function markdown(summary: ReturnType<typeof summarize>) {
  const a = summary.aggregate;
  const lines = [`# ${summary.dataset}`, "", `Completed ${a.complete}/${a.total}; human confirmed ${a.humanConfirmed}; agent-adjudicated ${a.agentConfirmed}; pending ${a.pending}.`,
    "", "Semantic metrics exclude unconfirmed cases. Factual correctness, grounding and citation support are independent. Evidence indicators do not establish causality. Source matching normalizes whitespace and leading function export wrappers split by the AST chunker; filenames, profiles and import-path lists do not count as code evidence.",
    "", `Retrieval evidence: ${a.retrieval.present}/${a.retrieval.observed}; prompt evidence: ${a.prompt.present}/${a.prompt.observed}.`,
    `Factual coverage: ${a.factualCoverage ?? "unscored"}; fully grounded: ${a.fullyGroundedRate ?? "unscored"}; citation support: ${a.citationSupport ?? "unscored"}.`,
    `Latency: ${(a.totalMs / 1000).toFixed(1)}s; provider input/output tokens: ${a.inputTokens ?? "unknown"}/${a.outputTokens ?? "unknown"}. Costs unknown; indexing/setup excluded. Prompt characters are not token usage.`, ""];
  lines.push(`Fully correct and complete answers: ${a.fullyCorrectAnswers}/${a.confirmed}; expected checklist facts fully covered: ${a.correctFacts}/${a.expectedFacts}. Compound facts receive no partial credit; omissions are not the same as false statements.`, "",
    "| Case | Full checklist items | Complete and correct | Grounding | Citation support |", "|---|---|---|---|---|",
    ...summary.cases.map(c => `| ${c.id} | ${c.semantic ? c.semantic.correctFacts + "/" + c.semantic.expectedFacts : "pending"} | ${c.semantic?.factuallyCorrect ?? "pending"} | ${c.semantic?.grounding ?? "pending"} | ${c.semantic?.citationCount ? c.semantic.supportedCitations + "/" + c.semantic.citationCount : "n/a"} |`), "");
  for (const c of summary.cases) {
    lines.push(`## ${c.id}`, "", c.question, "", "**Expected (source/test verified):**", "", ...c.expected.map(f => `- ${f.id}: ${f.text}`), "", "**Actual answer:**", "", c.answer || "No answer generated.", "", `Status: ${c.status}; ${c.adjudication}.${c.error ? ` Error: ${c.error}` : ""}`, "", "| Evidence | Retrieved | Final prompt |", "|---|---|---|", ...c.evidence.map(e => `| ${e.path} / ${e.id} | ${e.retrieved ?? "unknown"} | ${e.prompt ?? "unknown"} |`), "", `Indicator: ${c.indicator}.`, `Citation IDs resolving: ${c.citations.resolving}/${c.citations.count}; this does not establish citation support.`, `Latency ${(c.latencyMs / 1000).toFixed(1)}s; tokens ${c.usage?.inputTokens ?? "unknown"}/${c.usage?.outputTokens ?? "unknown"}.`, "");
    if (c.generationAttempts.length) lines.push(`Generation attempts: ${c.generationAttempts.length}; retry backoff: ${c.retryWaitMs}ms.`, "");
    if (c.semantic) lines.push(`Finalized factual coverage: ${c.semantic.correctFacts}/${c.semantic.expectedFacts}; fully factually correct: ${c.semantic.factuallyCorrect}; grounding: ${c.semantic.grounding}; citation support: ${c.semantic.supportedCitations}/${c.semantic.citationCount} (${c.semantic.citationSupport ?? "n/a"}); citation completeness: ${c.semantic.citationCompleteness}.`, "");
  }
  for (const c of summary.cases) if (c.assessment) {
    lines.push(`### Final adjudication: ${c.id}`, "", `Reviewer: ${c.assessment.reviewer}; ${c.adjudication}.`, "", c.assessment.notes, "",
      ...c.assessment.facts.map((f: any) => `- **${f.id}: ${f.verdict}** ? ${f.notes}`), "",
      `Additional factual errors: ${c.assessment.additionalFactualErrors.verdict}. ${c.assessment.additionalFactualErrors.notes}`,
      `Grounding: ${c.assessment.grounding.verdict}. ${c.assessment.grounding.notes}`, "",
      ...c.assessment.citations.map((v: any) => `- Citation ${v.id}: ${v.support}. ${v.notes}`), "",
      `Citation completeness: ${c.assessment.citationCompleteness.verdict}. ${c.assessment.citationCompleteness.notes}`, "");
  }
  for (const c of summary.cases) if (!c.semantic && c.proposedClassification) lines.push(`### Provisional inspection: ${c.id}`, "", "Pending human confirmation; excluded from scores.", "", typeof c.proposedClassification === "string" ? c.proposedClassification : JSON.stringify(c.proposedClassification, null, 2), "");
  return lines.join("\n");
}
