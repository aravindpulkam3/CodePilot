import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIndex, assertIndexUnchanged, assertSnapshot, snapshotHash, evidenceCoverage,
  metrics, newAdjudication, scoreCase, summarize, estimateCost, type PilotCase, type Artifact } from './evaluation.js';

const c = (): PilotCase => ({ id: 'case', pullNumber: 1, headSha: 'head', baseSha: 'base', prTitle: 'Update',
  prDescription: null, snapshotHash: '', expectedFindings: [{ id: 'b1', file: 'src/config.js',
    lineStart: 6, lineEnd: 6, rootCause: 'units', trigger: 'reserve', consequence: 'expires', evidence: 'test', acceptableAnchorPaths: ['src/config.js'] }],
  requiredContext: [{ file: 'src/reservations.js', requiredSource: ['now = Date.now', 'expiresAt: timestamp + lifetime'], reason: 'caller contract' }] });
const a = (count = 1): Artifact => ({ caseId: 'case', status: 'complete', elapsedMs: 123,
  events: [{ stage: 'validated', data: { findings: Array.from({ length: count }, () => ({ file_path: 'src/config.js', title: 'Duration', description: 'Seconds used as milliseconds' })) } },
    { stage: 'request', data: { reviewInput: { files: [{ filename: 'src/config.js', hunks: [{ newStart: 1, newLines: 7, included: true }] }] } } },
    ...['initial', 'selected', 'verified', 'prompt'].map((stage) => ({ stage, data: { codeChunks: [{ filePath: 'src/reservations.js', commitSha: 'head', content: 'now = Date.now; expiresAt: timestamp + lifetime' }] } }))] });
function matched(artifact: Artifact) {
  const adj = newAdjudication(artifact);
  adj.confirmed = true;
  Object.assign(adj.findings[0], { disposition: 'matched', expectedBugId: 'b1', rootCauseConfirmed: true, triggerOrConsequenceConfirmed: true, locationConfirmed: true, notes: 'Root cause and observable expiry are explained at the config return.' });
  return adj;
}

test('snapshot validation rejects head/base and mutable metadata/patch drift', () => {
  const input = { title: 'Update', description: null, head_sha: 'head', base_sha: 'base', files: [{ filename: 'a.js', status: 'modified', patch: '+x' }] };
  const scenario = { ...c(), snapshotHash: snapshotHash(input) };
  assert.doesNotThrow(() => assertSnapshot(scenario, input));
  for (const drift of [{ head_sha: 'new' }, { base_sha: 'new' }, { title: 'Changed' }, { description: 'Changed' }, { files: [] }]) assert.throws(() => assertSnapshot(scenario, { ...input, ...drift }), /DRIFT/);
});
test('index validation requires a frozen READY index and unchanged contents', () => {
  const index = { indexing_status: 'READY', last_indexed_sha: 'base', chunks: 2, revisions: ['base'], digest: 'a' };
  assert.doesNotThrow(() => assertIndex(index, 'base'));
  for (const changes of [{ indexing_status: 'INDEXING' }, { last_indexed_sha: 'other' }, { chunks: 0 }, { revisions: ['base', 'other'] }]) assert.throws(() => assertIndex({ ...index, ...changes }, 'base'));
  assert.throws(() => assertIndexUnchanged(index, { ...index, digest: 'b' }, 'base'), /CHANGED/);
});
test('evidence requires actual fragments at the exact path and verified head', () => {
  const artifact = a();
  assert.equal(evidenceCoverage(c(), artifact).prompt.matched, 1);
  const prompt = artifact.events.find((e) => e.stage === 'prompt')!;
  prompt.data.codeChunks[0].filePath = 'other/src/reservations.js';
  assert.equal(evidenceCoverage(c(), artifact).prompt.matched, 0);
  prompt.data.codeChunks[0].filePath = 'src/reservations.js';
  prompt.data.codeChunks[0].content = '// File: src/reservations.js\n// Type: now = Date.now\n// Name: expiresAt: timestamp + lifetime\nactualCode';
  assert.equal(evidenceCoverage(c(), artifact).prompt.matched, 0);
  prompt.data.codeChunks[0].content = 'now = Date.now; expiresAt: timestamp + lifetime';
  prompt.data.codeChunks[0].commitSha = 'old';
  assert.equal(evidenceCoverage(c(), artifact).prompt.matched, 0);
});
test('fragments may span real selected chunks but skeletons do not count', () => {
  const artifact = a();
  const prompt = artifact.events.find((e) => e.stage === 'prompt')!;
  prompt.data = { enclosing: { files: [{ filename: 'src/reservations.js', chunks: [
    { content: 'now = Date.now', symbolType: 'function' }, { content: 'expiresAt: timestamp + lifetime', symbolType: 'function' },
  ] }] } };
  assert.equal(evidenceCoverage(c(), artifact).prompt.matched, 1);
  prompt.data.enclosing.files[0].chunks[1].symbolType = 'class_skeleton';
  assert.equal(evidenceCoverage(c(), artifact).prompt.matched, 0);
});
test('retrieval source labels and stripped prompt headers cannot disguise a skeleton', () => {
  const artifact = a();
  const original = artifact.events.find((e) => e.stage === 'verified')!.data.codeChunks[0];
  original.contentHash = 'skeleton'; original.symbolType = 'graph_dependent';
  original.content = '// File: src/reservations.js\n// Type: class_skeleton\n' + original.content;
  const prompt = artifact.events.find((e) => e.stage === 'prompt')!.data.codeChunks[0];
  prompt.contentHash = 'skeleton'; prompt.symbolType = 'graph_dependent';
  assert.equal(evidenceCoverage(c(), artifact).verified.matched, 0);
  assert.equal(evidenceCoverage(c(), artifact).prompt.matched, 0);
});
test('manual matches require all confirmations and give one credit per bug', () => {
  const artifact = a(); const adj = matched(artifact);
  assert.deepEqual(scoreCase(c(), artifact, adj).metrics, metrics(1, 0, 0));
  adj.findings[0].rootCauseConfirmed = false;
  assert.throws(() => scoreCase(c(), artifact, adj), /confirmation/);
  const two = a(2); const double = matched(two);
  double.findings[1] = { ...double.findings[0], findingId: 'f2' };
  assert.throws(() => scoreCase(c(), two, double), /multiple/);
  double.findings[1] = { ...double.findings[1], disposition: 'duplicate', duplicateOf: 'f1' };
  assert.equal(scoreCase(c(), two, double).metrics?.tp, 1);
});
test('pending, stale and valid-unexpected findings cannot produce final metrics', () => {
  const artifact = a(); const adj = newAdjudication(artifact);
  assert.equal(scoreCase(c(), artifact, adj).metrics, null);
  adj.confirmed = true; adj.findings[0].disposition = 'valid_unexpected'; adj.findings[0].notes = 'Needs independent reproduction and ground-truth update';
  assert.equal(scoreCase(c(), artifact, adj).metrics, null);
  artifact.elapsedMs++;
  assert.throws(() => scoreCase(c(), artifact, adj), /stale/);
});
test('safe cases preserve undefined denominators and count false alarms', () => {
  const safe = { ...c(), expectedFindings: [], requiredContext: [], safeRationale: 'equivalent' };
  const empty = a(0); const clean = newAdjudication(empty); clean.confirmed = true;
  assert.deepEqual(scoreCase(safe, empty, clean).metrics, metrics(0, 0, 0));
  const noisy = a(); const adj = newAdjudication(noisy); adj.confirmed = true;
  adj.findings[0].disposition = 'false_positive'; adj.findings[0].notes = 'Guard makes this allegation incorrect';
  const result = scoreCase(safe, noisy, adj);
  assert.equal(result.falseAlarms, 1); assert.equal(result.metrics?.recall, null);
});
test('miss attribution follows missing evidence, not a generic reasoning label', () => {
  for (const [stage, diagnosis] of Object.entries({ initial: 'required_context_not_discovered', selected: 'lost_during_retrieval_selection', verified: 'lost_during_head_verification', prompt: 'lost_during_prompt_budgeting' })) {
    const artifact = a(0); let drop = false;
    for (const event of artifact.events) {
      if (event.stage === stage) drop = true;
      if (drop) event.data.codeChunks = [];
    }
    const adj = newAdjudication(artifact); adj.confirmed = true;
    assert.equal(scoreCase(c(), artifact, adj).missed[0].diagnosis, diagnosis);
  }
  const artifact = a(0); const adj = newAdjudication(artifact); adj.confirmed = true;
  assert.equal(scoreCase(c(), artifact, adj).missed[0].diagnosis, 'missed_despite_declared_evidence_present');
  artifact.events.find((e) => e.stage === 'request')!.data.reviewInput.files[0].hunks[0].included = false;
  const next = newAdjudication(artifact); next.confirmed = true;
  assert.equal(scoreCase(c(), artifact, next).missed[0].diagnosis, 'changed_source_omitted');
});
test('failed cases hold aggregate metrics pending rather than inflating results', () => {
  const artifact = { ...a(), status: 'failed' as const };
  const result = summarize({ version: 1, githubRepository: 'o/r', expectedIndexSha: 'base', cases: [c()] }, [artifact], {});
  assert.equal(result.aggregate, null); assert.equal(result.completed, 0); assert.equal(result.usage.inputTokens, null);
});
test('pricing never substitutes budget estimates for usage or ignores thinking costs', () => {
  assert.equal(estimateCost(undefined).generationApiUsd, null);
  assert.equal(estimateCost({ provider: 'ollama' }).generationApiUsd, 0);
  const pricing = { model: 'test', currency: 'USD' as const, sourceUrl: 'https://example.com/pricing', effectiveDate: '2026-10-10', inputPerMillion: 1, outputPerMillion: 2, billing: 'uncached-text-no-thinking' as const };
  const provider = { provider: 'gemini', model: 'test', usage: { inputTokens: 1000, outputTokens: 100 } };
  assert.equal(estimateCost(provider, pricing).generationApiUsd, .0012);
  assert.equal(estimateCost({ ...provider, usage: { ...provider.usage, metadata: { thoughtsTokenCount: 1 } } }, pricing).generationApiUsd, null);
});
