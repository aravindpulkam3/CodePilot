// Local only. Verify all scenarios before creating independent branch refs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scenarios } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [repositoryArg, outputArg, pilotArg] = process.argv.slice(2);
assert.ok(repositoryArg && outputArg && pilotArg, 'Usage: node prepare.mjs <benchmark-repo> <private-output-dir> <pilot-manifest>');
const repository = fs.realpathSync(repositoryArg);
const output = path.resolve(outputArg);
assert.ok(output.toLowerCase() !== repository.toLowerCase() && !output.toLowerCase().startsWith(repository.toLowerCase() + path.sep), 'Ground truth must stay outside the indexed repository');
const pilot = JSON.parse(fs.readFileSync(pilotArg, 'utf8'));
const base = pilot.expectedIndexSha;
const digest = value => createHash('sha256').update(value).digest('hex');
function git(args, options = {}) {
  const r = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', ...options });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}
assert.equal(git(['status', '--porcelain']).trim(), '', 'Benchmark working tree must be clean');
assert.equal(git(['rev-parse', 'main']).trim(), base, 'Frozen main changed');
const originalHead = git(['rev-parse', 'HEAD']).trim();
for (const c of pilot.cases) assert.equal(git(['rev-parse', c.branch]).trim(), c.headSha, 'Pilot branch changed');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(output, 'scratch'), { recursive: true });
const scratch = fs.mkdtempSync(path.join(output, 'scratch', 'expansion-'));
const resultsDir = path.join(output, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
const baseFiles = new Map(git(['ls-tree', '-r', '--name-only', base]).trim().split('\n').map(file => [file, git(['show', `${base}:${file}`])]));
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length, 2, 'Mutation must have exactly one match');
  return source.replace(before, after);
};
function materialize(label, files) {
  const dir = path.join(scratch, label);
  for (const [file, text] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}
function suite(dir, label, kind, files, expectedFailures = []) {
  const env = { ...process.env, BENCHMARK_REPO: dir };
  delete env.RESERVATION_TTL_SECONDS;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  const tap = r.stdout + r.stderr;
  fs.writeFileSync(path.join(resultsDir, `${label}-${kind}.tap`), tap);
  const failures = [...tap.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]).sort();
  assert.deepEqual(failures, [...expectedFailures].sort(), `${label}/${kind} unexpected failures`);
  assert.equal(r.status, expectedFailures.length ? 1 : 0);
  const count = key => Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1]);
  assert.ok(count('tests') > 0);
  assert.equal(count('fail'), expectedFailures.length);
  assert.equal(count('skipped'), 0);
  const result = { tests: count('tests'), passed: count('pass'), failed: count('fail'), failures, tapSha256: digest(tap) };
  console.log(`${label}/${kind}: ${result.passed}/${result.tests}${result.failed ? ' (expected failures)' : ''}`);
  return result;
}
function verify(dir, label, scenario) {
  return {
    application: suite(dir, label, 'application', ['test/pricing.test.js', 'test/shop.test.js'], scenario?.applicationFailures),
    behavioral: suite(dir, label, 'behavioral', [path.join(here, 'behavior.test.mjs')], scenario?.behavioralFailures),
  };
}
const results = [{ id: 'base', ...verify(materialize('base', baseFiles), 'base') }];
const prepared = [];
for (const c of scenarios) {
  let changed = replaceOnce(baseFiles.get(c.file), c.before, c.after);
  if (c.second) changed = replaceOnce(changed, c.second.before, c.second.after);
  const files = new Map(baseFiles).set(c.file, changed);
  for (const r of c.requiredContext) for (const fragment of r.requiredSource) {
    assert.ok(baseFiles.get(r.file)?.includes(fragment), `${c.id}: required context missing at base`);
    assert.ok(files.get(r.file)?.includes(fragment), `${c.id}: required context missing at head`);
  }
  const verification = verify(materialize(c.id, files), c.id, c);
  let corrected = null;
  if (c.rootCause) {
    // Apply the minimal corrective edit to the changed snapshot, not a replacement with the base tree.
    const fixes = {
      'delivery-threshold': ['subtotalCents > 7500', 'subtotalCents >= 7500'],
      'line-amounts': ['subtotalCents = lineAmountCents;', 'subtotalCents += lineAmountCents;'],
      'stock-replenishment': ['const nextStock = quantity;', 'const nextStock = available(productId) + quantity;'],
      'shop-clock': ['createReservations(inventory);', 'createReservations(inventory, now);'],
      'checkout-units': ['productId, units, expiresAt, status };', 'productId, quantity: units, expiresAt, status };'],
      'catalog-amounts': ['const unitPrice = product.priceCents / 100;', 'const unitPrice = product.priceCents;'],
    };
    const [before, after] = fixes[c.id];
    const correctedFiles = new Map(files).set(c.file, replaceOnce(changed, before, after));
    corrected = { fix: { file: c.file, before, after }, ...verify(materialize(`${c.id}-corrected`, correctedFiles), `${c.id}-corrected`) };
  }
  prepared.push({ c, changed, verification, corrected });
}

// All oracle checks passed. Write Git objects using a private index; never switch
// the user's checkout, touch its index or force-update an existing branch.
const cases = [];
for (const { c, changed, verification, corrected } of prepared) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, `${c.id}.index`) };
  git(['read-tree', base], { env });
  const blob = git(['hash-object', '-w', '--stdin'], { input: changed }).trim();
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},${c.file}`], { env });
  const tree = git(['write-tree'], { env }).trim();
  const exists = spawnSync('git', ['-C', repository, 'show-ref', '--verify', '--quiet', `refs/heads/${c.branch}`]).status === 0;
  let headSha;
  if (exists) {
    headSha = git(['rev-parse', c.branch]).trim();
    assert.equal(git(['rev-parse', `${headSha}^{tree}`]).trim(), tree, 'Existing branch differs; refusing overwrite');
    assert.equal(git(['rev-parse', `${headSha}^`]).trim(), base);
  } else {
    headSha = git(['commit-tree', tree, '-p', base], { input: `${c.prTitle}\n` }).trim();
    git(['update-ref', `refs/heads/${c.branch}`, headSha, '0'.repeat(40)]);
  }
  const patch = git(['diff', '--no-ext-diff', '--binary', base, headSha]);
  fs.mkdirSync(path.join(output, 'patches'), { recursive: true });
  fs.writeFileSync(path.join(output, 'patches', `${c.id}.patch`), patch);
  const line = c.anchor ? changed.split('\n').findIndex(l => l.includes(c.anchor)) + 1 : null;
  if (c.rootCause) assert.ok(line > 0);
  cases.push({ id: c.id, branch: c.branch, tags: c.tags, pullNumber: null,
    baseSha: base, headSha, snapshotHash: null, publicationStatus: 'local-only',
    prTitle: c.prTitle, prDescription: c.prDescription,
    expectedFindings: c.rootCause ? [{ id: `${c.id}-B1`, file: c.file, lineStart: line, lineEnd: line,
      rootCause: c.rootCause, trigger: c.trigger, consequence: c.consequence, evidence: c.evidence,
      acceptableAnchorPaths: [c.file] }] : [],
    requiredContext: c.requiredContext, ...(c.safeRationale ? { safeRationale: c.safeRationale } : {}),
    verification: { patchSha256: digest(patch), application: verification.application, behavioral: verification.behavioral, corrected },
  });
  results.push({ id: c.id, headSha, ...verification, corrected });
}
const manifest = { ...pilot, version: 2, status: 'draft-unpublished',
  verification: { method: 'Base/head/minimally corrected behavioral execution plus source inspection', evidence: 'verification.json', humanReview: 'Not independently human-reviewed' },
  cases: [...pilot.cases, ...cases] };
const writeJson = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
writeJson('cases-v2.draft.json', manifest);
writeJson('verification.json', { baseSha: base, verifiedAt: new Date().toISOString(), node: process.version,
  oracleSha256: digest(fs.readFileSync(path.join(here, 'behavior.test.mjs'))), results });
fs.writeFileSync(path.join(output, 'proposed-prs.md'), '# Proposed PR descriptions\n\n' + cases.map(c =>
  `## ${c.prTitle}\n\nBranch: \`${c.branch}\`\n\n${c.prDescription}\n`).join('\n'));
fs.writeFileSync(path.join(output, 'verification.md'), '# Local expansion verification\n\nAll heads are independent children of the frozen base. No GitHub PRs were created.\n\n' +
  '| Case | Type | Head application | Head private checks | Corrected application/private |\n| --- | --- | --- | --- | --- |\n' + cases.map(c => {
    const v = c.verification;
    return `| ${c.id} | ${c.tags[0]} | ${v.application.passed}/${v.application.tests} | ${v.behavioral.passed}/${v.behavioral.tests} | ${v.corrected ? `${v.corrected.application.passed}/${v.corrected.application.tests}; ${v.corrected.behavioral.passed}/${v.corrected.behavioral.tests}` : 'safe: no correction'} |`;
  }).join('\n') + '\n\nBug-head failures are intentional, with exact failure names checked. Existing public tests were not altered or hidden. Base and all corrections pass. Private generated-basket checks exercise 36 two-line combinations plus empty input.\n');
assert.equal(git(['rev-parse', 'HEAD']).trim(), originalHead);
assert.equal(git(['status', '--porcelain']).trim(), '');
assert.equal(git(['rev-parse', 'main']).trim(), base);
for (const c of pilot.cases) assert.equal(git(['rev-parse', c.branch]).trim(), c.headSha);
console.log(`Verified and prepared ${cases.length} local branches. Saved ${output}`);
