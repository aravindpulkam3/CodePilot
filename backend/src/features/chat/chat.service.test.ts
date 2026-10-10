import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const state = { calls: [] as any[], fail: false, model: "" };
const boundary = {
  async query(sql: string, values: any[]) {
    state.calls.push({ type: "sql", sql, values });
    if (sql.includes("SELECT role, content")) {
      assert.match(sql, /ORDER BY created_at DESC\s+LIMIT 10/);
      return { rows: [{ role: "user", content: "current" }, { role: "assistant", content: "earlier answer" }, { role: "user", content: "earlier question" }] };
    }
    return { rows: [] };
  },
  async buildContext(...args: any[]) { state.calls.push({ type: "context", args }); return { systemPrompt: "system", metadata: { preserved: true } }; },
  async *stream(messages: any[], model = "") { state.model = model; state.calls.push({ type: "stream", messages }); yield { text: "response" }; if (state.fail) throw new Error("provider failed"); },
  async after(...args: any[]) { state.calls.push({ type: "after", args }); },
};
(globalThis as any).__chatBoundary = boundary;
const provider = "export class Provider {buildContext(...a){return globalThis.__chatBoundary.buildContext(...a)} onAfterResponse(...a){return globalThis.__chatBoundary.after(...a)}}";
const mocks: Record<string, string> = {
  "../../config/db.js": "export const pool={query:(...a)=>globalThis.__chatBoundary.query(...a)};",
  "../../shared/utils/ownership.js": "export const assertOwnedContext=async()=>{};",
  "../../infrastructure/llm/llm.service.js": "export const ollamaService={modelName:'ollama',stream:(messages)=>globalThis.__chatBoundary.stream(messages,'ollama')}; export const repositoryQALLM={modelName:'gemini',stream:(messages)=>globalThis.__chatBoundary.stream(messages,'gemini')}; export const llmService=repositoryQALLM;",
  "./providers/repositoryContext.provider.js": provider + "export {Provider as RepositoryContextProvider};",
  "./providers/reviewContext.provider.js": provider + "export {Provider as ReviewContextProvider};",
  "./providers/issueContext.provider.js": provider + "export {Provider as IssueContextProvider};",
  "../dashboard/activityLog.service.js": "export const activityLogService={};",
};
const hooks = registerHooks({ resolve(specifier, context, next) { return mocks[specifier] ? { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true } : next(specifier, context); } });
const { ChatService } = await import("./chat.service.js"); hooks.deregister();
after(() => { delete (globalThis as any).__chatBoundary; });
beforeEach(() => { state.calls = []; state.fail = false; });
const session: any = { id: "session", user_id: "user", type: "REPO_QA", repository_id: "repo" };
test("production retains user write, LIMIT 10 history, stream, assistant write, timestamps and after-hook ordering", async () => {
  const chunks: any[] = [];
  await new ChatService().streamMessage(session, "current", "clerk", c => chunks.push(c), false);
  assert.deepEqual(state.calls.map(x => x.type), ["sql", "sql", "context", "stream", "sql", "sql", "after"]);
  assert.deepEqual(state.calls[0].values.slice(0, 3), ["session", "user", "current"]);
  const history = [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }, { role: "user", content: "current" }];
  assert.deepEqual(state.calls[2].args[3], { isNewSession: false, recentHistory: history });
  assert.deepEqual(state.calls[3].messages, [{ role: "system", content: "system" }, ...history]);
  assert.deepEqual(state.calls[4].values, ["session", "assistant", "response", JSON.stringify({ preserved: true })]);
  assert.match(state.calls[5].sql, /updated_at = NOW\(\), last_accessed_at = NOW\(\)/);
  assert.deepEqual(chunks.map(x => x.type), ["metadata", "text"]);
});
test("failed generation retains only the already-saved user message", async () => {
  state.fail = true;
  await assert.rejects(new ChatService().streamMessage(session, "current", "clerk", () => {}), /provider failed/);
  assert.equal(state.calls.filter(x => x.type === "sql" && x.sql.includes("INSERT")).length, 1);
  assert.ok(!state.calls.some(x => x.type === "after" || x.sql?.includes("UPDATE")));
});
test("unsupported session types fail before persistence", async () => {
  await assert.rejects(new ChatService().streamMessage({ ...session, type: "INTERVIEW" }, "current", "clerk", () => {}), /Unsupported/);
  assert.equal(state.calls.length, 0);
});

test("repository Q&A and its alias use Gemini while review/finding chats retain their adapter", async () => {
  for (const type of ["REPO_QA", "QA", "REVIEW_CHAT", "ISSUE_CHAT"]) {
    await new ChatService().streamMessage({ ...session, type } as any, "current", "clerk", () => {});
    assert.equal(state.model, ["REPO_QA", "QA"].includes(type) ? "gemini" : "ollama");
  }
});
