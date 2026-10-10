// Explicit operator action: push only prepared branches and create their PRs.
// Run with node --import tsx so the shared snapshot/manifest helpers are reused.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { snapshotHash, validateManifest } from '../evaluation.js';
import { fetchPullRequestSnapshot } from '../../../src/infrastructure/github/pullRequestSnapshot.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = fs.realpathSync(process.argv[2]);
const draft = JSON.parse(fs.readFileSync(path.join(here, 'cases-v2.draft.json'), 'utf8'));
const identity = draft.githubRepository;
assert.equal(identity, 'aravindpulkam3/parcel-shop-benchmark');
const secrets = [];
function git(args, input, extraEnv = {}) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    input, encoding: 'utf8', env: { ...process.env,
      GIT_TERMINAL_PROMPT: process.argv.includes('--interactive-auth') ? '1' : '0',
      GCM_INTERACTIVE: process.argv.includes('--interactive-auth') ? 'auto' : 'never', ...extraEnv },
  });
  if (result.status !== 0) {
    let detail = result.stderr ?? '';
    for (const secret of secrets) detail = detail.replaceAll(secret, '[redacted]');
    detail = detail.replace(/https?:\/\/[^\s]+/g, '[remote URL]').slice(0, 1200);
    throw new Error(`Git ${args[0]} failed: ${detail}`);
  }
  return result.stdout.trim();
}

try {
  assert.equal(git(['remote', 'get-url', 'origin']), `https://github.com/${identity}.git`);
  assert.equal(git(['status', '--porcelain']), '', 'Benchmark checkout must be clean');
  assert.equal(git(['rev-parse', 'main']), draft.expectedIndexSha);
  for (const c of draft.cases) assert.equal(git(['rev-parse', c.branch]), c.headSha, `Local revision drift: ${c.id}`);
  // Use Git's configured credential helper. Never print or save its response.
  let token;
  try {
    const credentials = git(['credential', 'fill'], `protocol=https\nhost=github.com\npath=${identity}.git\n\n`);
    token = credentials.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
  } catch { /* The existing CodePilot GitHub connection is an alternative. */ }
  if (!token) {
    await import('dotenv/config');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
    try {
      const [owner, name] = identity.split('/');
      const { rows } = await pool.query('SELECT u.clerk_id FROM repositories r JOIN app_users u ON u.id = r.user_id WHERE r.owner = $1 AND r.name = $2', [owner, name]);
      assert.equal(rows.length, 1, 'Expected exactly one owned benchmark repository');
      const { clerkClient } = await import('@clerk/express');
      const response = await clerkClient.users.getUserOauthAccessToken(rows[0].clerk_id, 'github');
      token = response.data?.[0]?.token;
    } catch { throw new Error('Cannot obtain GitHub authorization from the existing CodePilot connection'); }
    finally { await pool.end(); }
  }
  assert.ok(token, 'No GitHub credential available');
  secrets.push(token, Buffer.from(`x-access-token:${token}`).toString('base64'));
  async function api(endpoint, body) {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub ${body ? 'POST' : 'GET'} ${endpoint}: HTTP ${response.status}`);
    return { data: await response.json(), hasNext: /rel="next"/.test(response.headers.get('link') ?? '') };
  }
  const repoInfo = (await api(`/repos/${identity}`)).data;
  assert.ok(repoInfo.permissions?.push, 'Authenticated GitHub user lacks push permission');
  assert.equal((await api(`/repos/${identity}/git/ref/heads/main`)).data.object.sha, draft.expectedIndexSha);
  const prs = [];
  for (let page = 1; ; page++) {
    const result = await api(`/repos/${identity}/pulls?state=all&per_page=100&page=${page}`);
    prs.push(...result.data);
    if (!result.hasNext) break;
  }
  const newCases = draft.cases.filter(c => c.pullNumber === null);
  for (const c of newCases) {
    const existing = prs.filter(pr => pr.head.ref === c.branch && pr.head.repo?.full_name === identity);
    assert.ok(existing.length <= 1, `Multiple PRs already exist for ${c.branch}`);
    if (existing[0]) {
      assert.equal(existing[0].state, 'open');
      assert.equal(existing[0].base.ref, 'main');
      assert.equal(existing[0].head.sha, c.headSha);
    }
  }
  if (!process.argv.includes('--already-pushed')) git(['push', '--atomic', 'origin', ...newCases.map(c => `refs/heads/${c.branch}:refs/heads/${c.branch}`)], undefined, {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  });
  for (const c of newCases) {
    const remote = (await api(`/repos/${identity}/git/ref/heads/${c.branch}`)).data;
    assert.equal(remote.object.sha, c.headSha, `Remote branch drift: ${c.id}`);
  }
  console.log(`Verified ${newCases.length} published branch refs.`);
  for (const c of newCases) {
    let pr = prs.find(pr => pr.head.ref === c.branch && pr.head.repo?.full_name === identity);
    if (!pr) pr = (await api(`/repos/${identity}/pulls`, {
      title: c.prTitle, body: c.prDescription, head: c.branch, base: 'main',
    })).data;
    c.pullNumber = pr.number;
    c.prUrl = pr.html_url;
    console.log(`${c.id}: ${pr.html_url}`);
  }
  // Freeze real GitHub payloads through the same paginated acquisition helper.
  for (const c of draft.cases) {
    const endpoint = `/repos/${identity}/pulls/${c.pullNumber}`;
    const { metadata, files } = await fetchPullRequestSnapshot(
      async () => (await api(endpoint)).data,
      async page => { const r = await api(`${endpoint}/files?per_page=100&page=${page}`); return { files: r.data, hasNext: r.hasNext }; },
    );
    assert.equal(metadata.state, 'open');
    assert.equal(metadata.merged, false);
    assert.equal(metadata.base.ref, 'main');
    assert.equal(metadata.base.sha, c.baseSha, `Base drift: ${c.id}`);
    assert.equal(metadata.head.sha, c.headSha, `Head drift: ${c.id}`);
    const fingerprint = snapshotHash({ title: metadata.title, description: metadata.body, files });
    if (c.snapshotHash) assert.equal(fingerprint, c.snapshotHash, `Existing pilot snapshot drift: ${c.id}`);
    else {
      c.snapshotHash = fingerprint;
      c.prTitle = metadata.title;
      c.prDescription = metadata.body;
      c.publicationStatus = 'published';
    }
  }
  draft.status = 'published';
  validateManifest(draft);
  fs.writeFileSync(path.join(here, 'cases-v2.json'), JSON.stringify(draft, null, 2) + '\n');
  fs.writeFileSync(path.join(here, 'published-prs.md'), '# Published benchmark PRs\n\n' + draft.cases.map(c =>
    `- [#${c.pullNumber}: ${c.prTitle}](https://github.com/${identity}/pull/${c.pullNumber}) — \`${c.headSha}\``).join('\n') + '\n');
  console.log('Validated and saved runnable cases-v2.json for all 12 PRs. No PRs merged; no evaluation/model calls made.');
} catch (error) {
  // Never serialize request objects or credentials.
  console.error(error instanceof Error ? error.message : 'Publication failed');
  process.exitCode = 1;
}
