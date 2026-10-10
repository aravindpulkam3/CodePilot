import test from "node:test";
import assert from "node:assert/strict";
import { generateChatResponse } from "./chatGeneration.js";
import { observe } from "../../shared/utils/diagnostics.js";
import type { ChatSessionRecord } from "./chat.types.js";

const session: ChatSessionRecord = { id: "s", user_id: "u", type: "REPO_QA", repository_id: "r", status: "ACTIVE", created_at: "", updated_at: "" };
test("shared generation preserves exact prompt, ordered history and source/metadata/text streaming", async () => {
  const context = { systemPrompt: "unchanged system", metadata: { key: "value" }, promptContext: { version: 1 as const, repoHtmlUrl: null, items: [{ n: 1, displayable: true, kind: "code" as const, heading: "[1]", body: "source", truncated: false, filePath: "a.ts", commitSha: "sha" }] } };
  const history = [{ role: "user", content: "prior" }, { role: "assistant", content: "answer" }, { role: "user", content: "current" }];
  const run = async (diagnostics: boolean) => {
    const events: any[] = [], chunks: any[] = [], requests: any[] = [];
    const provider = { async buildContext(_s: any, q: string, id: string, conversation: any) {
      assert.equal(q, "current"); assert.equal(id, "clerk"); assert.deepEqual(conversation.recentHistory, history); assert.equal(conversation.isNewSession, false);
      return structuredClone(context);
    } };
    const llm = { modelName: "production", async *stream(messages: any, observer: any) {
      requests.push(structuredClone(messages)); observe(observer, "qa.usage", { inputTokens: 42, outputTokens: 2 });
      yield { text: "hello" }; yield { text: "" }; yield { text: " world" };
    } };
    const result = await generateChatResponse(provider, llm, session, "current", "clerk", history, x => chunks.push(x), {
      isNewSession: false,
      ...(diagnostics ? { onDiagnostic: (e: any) => { events.push(structuredClone(e)); if (e.stage === "qa.request") e.data.messages[0].content = "mutation"; } } : {}),
    });
    return { result, chunks, requests, events };
  };
  const normal = await run(false), diagnostic = await run(true);
  assert.deepEqual(diagnostic.result, normal.result); assert.deepEqual(diagnostic.chunks, normal.chunks); assert.deepEqual(diagnostic.requests, normal.requests);
  assert.deepEqual(normal.requests[0], [{ role: "system", content: context.systemPrompt }, ...history]);
  assert.deepEqual(normal.chunks.map(x => x.type), ["sources", "metadata", "text", "text"]);
  assert.equal(normal.result.fullAiResponse, "hello world");
  assert.deepEqual(diagnostic.events.map(x => x.stage), ["qa.request", "qa.usage", "qa.response"]);
});
test("a stream failure exposes partial text, propagates, and never emits a success diagnostic", async () => {
  const chunks: any[] = [], events: any[] = [];
  await assert.rejects(generateChatResponse({ buildContext: async () => ({ systemPrompt: "sys" }) }, {
    modelName: "production", async *stream() { yield { text: "partial" }; throw new Error("offline"); },
  }, session, "q", "clerk", [{ role: "user", content: "q" }], c => chunks.push(c), { isNewSession: true, onDiagnostic: e => events.push(e) }), /offline/);
  assert.equal(chunks[0].data, "partial"); assert.ok(!events.some(e => e.stage === "qa.response"));
});
test("context-provider history mutation cannot alter the independent LLM history", async () => {
  const history = [{ role: "user", content: "original" }];
  await generateChatResponse({ buildContext: async (_s, _q, _u, conversation) => {
    conversation!.recentHistory[0].content = "changed";
    return { systemPrompt: "sys" };
  } }, { modelName: "production", async *stream(messages) {
    assert.equal(messages[1].content, "original"); yield { text: "answer" };
  } }, session, "original", "clerk", history, () => {}, { isNewSession: true });
  assert.equal(history[0].content, "original");
});
