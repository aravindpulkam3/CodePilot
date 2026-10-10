import test from "node:test";
import assert from "node:assert/strict";
import { coverage, hash, newAdjudication, summarize, compareSummaries, citations, validateManifest, type Artifact, type Manifest } from "./evaluation.js";
import { assertIndex, assertIndexUnchanged } from "../review-eval/evaluation.js";
const sha = "a".repeat(40);
const m: Manifest = { version: 1, dataset: "test", githubRepository: "owner/repo", expectedIndexSha: sha, cases: [{ id: "one", question: "q", facts: [{ id: "f", text: "Returns 1" }], requiredContext: [{ id: "e", path: "src/a.js", fragments: ["return 1;"] }], verification: { test: "one", sourceInspection: ["src/a.js"], scope: "tested" } }] };
const c = m.cases[0];
const artifact = (): Artifact => ({ caseId: "one", status: "complete", elapsedMs: 1, answer: "It returns 1 [1].", events: [
  { stage: "qa.retrieved", data: { codeChunks: [{ filePath: "src/a.js", content: "return 1;", commitSha: sha }], metadata: {} } },
  { stage: "qa.request", data: { messages: [{ role: "system", content: "return 1;" }], context: { promptContext: { items: [{ filePath: "src/a.js", body: "return 1;", commitSha: sha, kind: "code", n: 1, displayable: true }] } } } },
] });
test("coverage requires exact path, revision and actual source, not filename mentions", () => {
  const a = artifact(); assert.equal(coverage(c, a, sha)[0].prompt, true);
  a.events[0].data.codeChunks[0].content = "src/a.js";
  assert.equal(coverage(c, a, sha)[0].retrieved, false);
  a.events[1].data.context.promptContext.items[0].commitSha = "wrong";
  assert.equal(coverage(c, a, sha)[0].prompt, false);
});
test("function bodies count when the AST stores the export wrapper separately", () => {
  const a = artifact(), declaration = "function lifetime() { return 1; }";
  a.events[0].data.codeChunks[0].content = "// Exported: true\n" + declaration;
  a.events[1].data.messages[0].content = declaration;
  a.events[1].data.context.promptContext.items[0].body = declaration;
  const requirement = { ...c, requiredContext: [{ id: "e", path: "src/a.js", fragments: ["export function lifetime()", "return 1;"] }] };
  assert.equal(coverage(requirement, a, sha)[0].retrieved, true);
  assert.equal(coverage(requirement, a, sha)[0].prompt, true);
  a.events[1].data.context.promptContext.items[0].body = "function lifetime() {}";
  a.events[1].data.messages[0].content = "function lifetime() {}";
  assert.equal(coverage(requirement, a, sha)[0].prompt, false);
});
test("retrieval loss and prompt budget loss are independently observable", () => {
  const a = artifact(); a.events[1].data.context.promptContext.items = [];
  assert.match(coverage(c, a, sha)[0].indicator, /lost during prompt/);
  a.events[0].data.codeChunks = [];
  assert.match(coverage(c, a, sha)[0].indicator, /not returned by retrieval/);
  a.events = []; assert.equal(coverage(c, a, sha)[0].retrieved, null);
});
test("synthetic profiles/imports and source omitted from actual request never prove evidence", () => {
  const a = artifact(); a.events[1].data.messages[0].content = "other";
  assert.equal(coverage(c, a, sha)[0].prompt, false);
  a.events[1].data.messages[0].content = "return 1;";
  a.events[1].data.context.promptContext.items[0].kind = "imports";
  assert.equal(coverage(c, a, sha)[0].prompt, false);
});
test("pending human confirmation suppresses all semantic scores, including proposed verdicts", () => {
  const a = artifact(), j = newAdjudication(c, a); j.proposedClassification = { factual: "correct" } as any;
  const s = summarize(m, [a], { one: j });
  assert.equal(s.aggregate.factualCoverage, null); assert.equal(s.aggregate.citationSupport, null); assert.equal(s.aggregate.confirmed, 0);
});
function confirmed(a: Artifact) {
  const j = newAdjudication(c, a);
  Object.assign(j, { humanConfirmed: true, groundTruthConfirmed: true, reviewer: "human", notes: "Checked sources and tests" });
  j.facts[0] = { id: "f", verdict: "correct", notes: "Matches verified return" };
  j.additionalFactualErrors = { verdict: "none", notes: "All additional assertions inspected" };
  j.grounding = { verdict: "supported", notes: "Prompt contains implementation" };
  j.citationCompleteness = { verdict: "supported", notes: "Main claim has citation" };
  j.citations = j.citations.map(x => ({ ...x, support: "supported", notes: "Same claim" }));
  return j;
}
test("correct facts with incorrect citations remain factually correct", () => {
  const a = artifact(), j = confirmed(a); j.citations[0].support = "unsupported";
  const s = summarize(m, [a], { one: j });
  assert.equal(s.aggregate.factuallyCorrectRate, 1); assert.equal(s.aggregate.fullyGroundedRate, 1); assert.equal(s.aggregate.citationSupport, 0);
});
test("zero citations produce null support, not fabricated perfect support", () => {
  const a = artifact(); a.answer = "Returns 1";
  const j = confirmed(a); j.citationCompleteness = { verdict: "unsupported", notes: "No citations" };
  assert.equal(summarize(m, [a], { one: j }).aggregate.citationSupport, null);
});
test("incomplete manual verdicts and mismatched saved outputs are rejected", () => {
  const a = artifact(), j = confirmed(a); j.groundTruthConfirmed = false;
  assert.throws(() => summarize(m, [a], { one: j }), /verification incomplete/);
  j.groundTruthConfirmed = true; j.facts[0].verdict = "unresolved";
  assert.throws(() => summarize(m, [a], { one: j }), /Fact adjudication/);
  a.answer += " altered";
  assert.throws(() => summarize(m, [a], { one: j }), /mismatch/);
});
test("invalid citation IDs cannot be manually called supported", () => {
  const a = artifact(); a.answer = "Returns 1 [1, 99]";
  assert.deepEqual(citations(a).map(x => x.resolves), [true, false]);
  assert.throws(() => summarize(m, [a], { one: confirmed(a) }), /Citation adjudication/);
});
test("frozen-index validation rejects wrong revision, mixed content and fingerprint drift", () => {
  const index = { indexing_status: "READY", last_indexed_sha: sha, chunks: 1, revisions: [sha], digest: "a" };
  assertIndex(index, sha);
  assert.throws(() => assertIndex({ ...index, last_indexed_sha: "wrong" }, sha));
  assert.throws(() => assertIndex({ ...index, revisions: [sha, "other"] }, sha));
  assert.throws(() => assertIndexUnchanged(index, { ...index, digest: "b" }, sha));
});
test("manifest validation rejects duplicate cases and missing source fragments", () => {
  validateManifest(m);
  assert.throws(() => validateManifest({ ...m, cases: [c, c] }));
  assert.throws(() => validateManifest({ ...m, cases: [{ ...c, requiredContext: [{ id: "e", path: "a.js", fragments: [] }] }] }));
  assert.notEqual(hash(m), hash({ ...m, dataset: "modified" }));
});
test("comparison never fabricates deltas for pending or different adjudication subsets", () => {
  const a = artifact();
  const pending = summarize(m, [a], { one: newAdjudication(c, a) });
  const scored = summarize(m, [a], { one: confirmed(a) });
  const different = compareSummaries(pending, scored);
  assert.equal(different.sameConfirmedSubset, false);
  assert.equal(different.metrics.find(x => x.metric === "factualCoverage")?.delta, null);
  const same = compareSummaries(scored, scored);
  assert.equal(same.sameConfirmedSubset, true);
  assert.equal(same.metrics.find(x => x.metric === "factualCoverage")?.delta, 0);
  assert.equal(same.cases[0].before.answer, same.cases[0].after?.answer);
});
test("confirmation flags must be booleans and failed cases cannot receive semantic credit", () => {
  const a = artifact(), j = confirmed(a);
  (j as any).humanConfirmed = "false";
  assert.throws(() => summarize(m, [a], { one: j }), /must be boolean/);
  j.humanConfirmed = true; a.status = "failed"; j.artifactHash = hash(a);
  assert.throws(() => summarize(m, [a], { one: j }), /verification incomplete/);
});
test("agent adjudication finalizes scores without claiming human verification", () => {
  const a = artifact(), j = confirmed(a);
  j.humanConfirmed = false;
  j.agentConfirmed = true;
  j.reviewer = "Codex (user-authorized agent)";
  const s = summarize(m, [a], { one: j });
  assert.equal(s.aggregate.confirmed, 1);
  assert.equal(s.aggregate.agentConfirmed, 1);
  assert.equal(s.aggregate.humanConfirmed, 0);
  assert.equal(s.aggregate.pending, 0);
  assert.equal(s.aggregate.factuallyCorrectRate, 1);
  assert.match(s.cases[0].adjudication, /agent-adjudicated/);
  assert.equal(s.cases[0].assessment?.reviewer, j.reviewer);
  j.groundTruthConfirmed = false;
  assert.throws(() => summarize(m, [a], { one: j }), /verification incomplete/);
});
test("agent confirmation rejects non-booleans, ambiguous provenance and unresolved verdicts", () => {
  const a = artifact(), j = confirmed(a);
  j.agentConfirmed = true;
  assert.throws(() => summarize(m, [a], { one: j }), /Ambiguous/);
  j.humanConfirmed = false;
  (j as any).agentConfirmed = "true";
  assert.throws(() => summarize(m, [a], { one: j }), /must be boolean/);
  j.agentConfirmed = true;
  j.facts[0].verdict = "unresolved";
  assert.throws(() => summarize(m, [a], { one: j }), /Fact adjudication/);
});
