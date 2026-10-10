import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import axios from "axios";

const mocks: Record<string, string> = {
  "@clerk/express": "export const clerkClient = {users:{getUserOauthAccessToken:async()=>({data:[{token:'test-token'}]})}};",
  "../../features/repository/repository.service.js": "export const findRepositoryById = async () => {throw new Error('unexpected repository lookup')};",
  "../../features/dashboard/dashboard.service.js": "export const logActivity = async () => {};",
  "../../shared/utils/cache.js": "export const withCache = async () => {throw new Error('revision must not be cached')};",
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (mocks[specifier]) return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  return next(specifier, context);
} });
const { getPullRequestRevision } = await import("./github.service.js");
hooks.deregister();

test("publication revision uses fresh metadata only, with authentication", async (t) => {
  let calls = 0;
  t.mock.method(axios, "get", async (url: string, config: any) => {
    assert.equal(url, "https://api.github.com/repos/owner/repo/pulls/7");
    assert.equal(config.headers.Authorization, "Bearer test-token");
    return { data: { head: { sha: `head-${++calls}` }, base: { sha: "base" } } };
  });
  assert.deepEqual(await getPullRequestRevision("clerk", { owner: "owner", name: "repo" }, 7), { head_sha: "head-1", base_sha: "base" });
  assert.deepEqual(await getPullRequestRevision("clerk", { owner: "owner", name: "repo" }, 7), { head_sha: "head-2", base_sha: "base" });
  assert.equal(calls, 2);
});

for (const data of [null, {}, { head: { sha: "head" } }, { head: { sha: "" }, base: { sha: "base" } }, { head: { sha: "head" }, base: { sha: 123 } }]) {
  test(`malformed revision rejected: ${JSON.stringify(data)}`, async (t) => {
    t.mock.method(axios, "get", async () => ({ data }));
    await assert.rejects(getPullRequestRevision("clerk", { owner: "o", name: "r" }, 1), /PR_REVISION_UNAVAILABLE/);
  });
}
for (const status of [404, 503]) {
  test(`revision HTTP ${status} propagates as an existing GitHub error`, async (t) => {
    t.mock.method(axios, "get", async () => { throw { isAxiosError: true, response: { status } }; });
    await assert.rejects(getPullRequestRevision("clerk", { owner: "o", name: "r" }, 1),
      new RegExp(status === 404 ? "GITHUB_NOT_FOUND" : "GITHUB_API_FAILURE"));
  });
}
