import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const repository = process.argv[2];
if (!repository) throw new Error('Usage: npm run eval:qa:verify -- <local Parcel Shop repository>');
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
const git = (...args) => execFileSync('git', ['-C', path.resolve(repository), ...args], { encoding: 'utf8' });
const sha = git('rev-parse', `${manifest.expectedIndexSha}^{commit}`).trim();
if (sha !== manifest.expectedIndexSha) throw new Error('Wrong frozen source revision');
const outputRoot = path.join(here, '../qa-eval-out');
fs.mkdirSync(outputRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(outputRoot, 'verify-'));
const files = git('ls-tree', '-r', '--name-only', sha).trim().split('\n');
const sources = {};
for (const file of files) {
  if (file.includes('..') || path.isAbsolute(file)) throw new Error('Unsafe tracked path');
  const content = git('show', `${sha}:${file}`);
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  sources[file] = { hash: hash(content), content };
}
const normalize = s => s.replace(/\s+/g, ' ').trim();
for (const c of manifest.cases) for (const e of c.requiredContext) for (const fragment of e.fragments) {
  if (!normalize(sources[e.path]?.content || '').includes(normalize(fragment))) throw new Error(`Ground truth source mismatch: ${c.id}/${e.id}`);
}
const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(here, 'behavior.test.mjs')], {
  env: { ...process.env, QA_FIXTURE_ROOT: root }, encoding: 'utf8', cwd: root,
});
const publicTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/*.test.js'], { encoding: 'utf8', cwd: root });
const report = { version: 1, sha, datasetHash: hash(manifest), verifiedAt: new Date().toISOString(), node: process.version,
  verifierHash: hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
  testsHash: hash(fs.readFileSync(path.join(here, 'behavior.test.mjs'), 'utf8')),
  status: tests.status === 0 && publicTests.status === 0 ? 'passed' : 'failed', exitCode: tests.status, output: tests.stdout, stderr: tests.stderr,
  publicTests: { exitCode: publicTests.status, output: publicTests.stdout, stderr: publicTests.stderr },
  sourceInspection: 'All tracked source modules, package.json and README recorded below. Lifetime is a literal; Maps are created afresh by shop construction; no env/storage reads in this implementation. Tests sample environment variables and use separate Node processes. These finite tests supplement source inspection, not a universal proof from absent retrieval.', sources };
fs.writeFileSync(path.join(here, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(tests.stdout); console.log(publicTests.stdout); console.log(`Verification: ${report.status}; ${path.join(here, 'verification.json')}`);
process.exitCode = report.status === 'passed' ? 0 : 1;
