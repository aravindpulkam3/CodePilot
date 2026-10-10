import { after, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const body = "function a() {\n" + "  const value = 'long evidence';\n".repeat(120) + "  return value;\n}";
const retrieved = { repositoryProfile: "profile", codeChunks: [{ filePath: "src/a.js", content: body, symbolName: "a", symbolType: "function", lineStart: 1, lineEnd: 124, similarity: 0.9, contentHash: "hash", commitSha: "sha" }], docChunks: [],  metadata: { evidenceSimilarities: { code: 0.9, doc: null } } };
(globalThis as any).__qaProvider = { retrieved, calls: [] as any[] };
const mocks: Record<string, string> = {
  "../../../infrastructure/retrieval/retreival.service.js": "export const retrievalService={retrieveQAContext:async(...args)=>{globalThis.__qaProvider.calls.push(args);return structuredClone(globalThis.__qaProvider.retrieved)}};",
  "../../repository/repository.service.js": "export const findRepositoryById=async()=>({html_url:'https://github.com/owner/repo'});",
};
const hooks = registerHooks({ resolve(specifier, context, next) { return mocks[specifier] ? { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true } : next(specifier, context); } });
const { RepositoryContextProvider } = await import("./repositoryContext.provider.js"); hooks.deregister();
after(() => { delete (globalThis as any).__qaProvider; });
test("optional provider observations preserve exact prompt and expose actual truncation", async () => {
  const provider = new RepositoryContextProvider(), session: any = { repository_id: "repo" };
  const conversation = { isNewSession: false, recentHistory: [{ role: "user" as const, content: "q" }] };
  const normal = await provider.buildContext(session, "q", "clerk", conversation);
  const events: any[] = [];
  const observed = await provider.buildContext(session, "q", "clerk", { ...conversation, skipSync: true, onDiagnostic: e => { events.push(structuredClone(e)); if (e.stage === "qa.retrieved") e.data.codeChunks.length = 0; if (e.stage === "qa.budgeted") e.data.items.length = 0; } });
  assert.deepEqual(observed, normal);
  assert.equal(events[0].data.codeChunks[0].content, body);
  assert.ok(events[1].data.items.find((x: any) => x.kind === "code").truncated);
  assert.ok(!normal.systemPrompt.includes("return value;"));
  const call = (globalThis as any).__qaProvider.calls[1];
  assert.equal(call[3], undefined); assert.equal(call[4].skipSync, true);
});
