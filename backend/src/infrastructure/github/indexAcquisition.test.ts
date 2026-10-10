import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const mocks: Record<string, string> = {
  "@clerk/express": "export const clerkClient = {};",
  "../../features/repository/repository.service.js": "export const findRepositoryById = async () => null;",
  "../../features/dashboard/dashboard.service.js": "export const logActivity = async () => {};",
  "../../shared/utils/cache.js": "export const withCache = async (_key, _ttl, fn) => fn();",
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (mocks[specifier]) return { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true };
  return next(specifier, context);
} });
const { fetchAllRepositoryFiles, getChangedFilesBetweenCommits } = await import("./github.service.js");
hooks.deregister();
const indexable = (path: string) => path.endsWith(".ts");

describe("index acquisition preserves empty files and retries missing source", () => {
  for (const mode of ["full", "delta"]) {
    const acquire = () => mode === "full"
      ? fetchAllRepositoryFiles(undefined, "owner", "repo", "head", indexable)
      : getChangedFilesBetweenCommits(undefined, "owner", "repo", "base", "head", indexable);
    const manifest = () => mode === "full" ? { tree: [{ type: "blob", path: "a.ts" }] }
      : { status: "ahead", files: [{ filename: "a.ts", status: "modified" }] };
    test(mode + " passes an empty string through the JSON job payload", async (t) => {
      t.mock.method(globalThis, "fetch", async (url: any) => new Response(String(url).includes("/contents/") ? "" : JSON.stringify(manifest())));
      const files = await acquire();
      assert.equal(files?.length, 1);
      assert.equal(JSON.parse(JSON.stringify(files))[0].content, "");
    });
    test(mode + " fails on unavailable source and re-fetches successfully on retry", async (t) => {
      let sourceCalls = 0;
      t.mock.method(globalThis, "fetch", async (url: any) => {
        if (!String(url).includes("/contents/")) return new Response(JSON.stringify(manifest()));
        assert.match(String(url), /ref=head$/);
        return ++sourceCalls === 1 ? new Response("", { status: 404 }) : new Response("");
      });
      await assert.rejects(acquire(), /Source content unavailable for a.ts/);
      assert.equal((await acquire())?.[0].content, "");
      assert.equal(sourceCalls, 2);
    });
    test(mode + " propagates transient HTTP errors rather than returning a prefix", async (t) => {
      t.mock.method(globalThis, "fetch", async (url: any) => String(url).includes("/contents/")
        ? new Response("", { status: 503, statusText: "Unavailable" }) : new Response(JSON.stringify(manifest())));
      await assert.rejects(acquire(), /Failed to fetch file content/);
    });
  }
  test("removals and renames to excluded paths legitimately carry null without fetching", async (t) => {
    const call = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status: "ahead", files: [
      { filename: "gone.ts", status: "removed" }, { filename: "new.bin", previous_filename: "old.ts", status: "renamed" },
    ] })));
    const files = await getChangedFilesBetweenCommits(undefined, "o", "r", "base", "head", indexable);
    assert.equal(call.mock.callCount(), 1);
    assert.deepEqual(files?.map((f) => f.content), [null, null]);
    assert.equal(files?.[1].previousPath, "old.ts");
  });
});
