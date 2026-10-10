import test from "node:test";
import assert from "node:assert/strict";
import { retryGenerationStream } from "./providerRetry.js";

const busy = () => Object.assign(new Error("Model currently unavailable"), { status: 503 });
test("stream retries pre-text failures up to five attempts with bounded backoff", async () => {
  let calls = 0;
  const delays: number[] = [], events: any[] = [], text: string[] = [];
  for await (const c of retryGenerationStream(async function* () {
    calls++;
    if (calls < 5) throw busy();
    yield { text: "answer" };
  }, e => events.push(e), async ms => { delays.push(ms); })) text.push(c.text);
  assert.equal(calls, 5); assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.deepEqual(text, ["answer"]); assert.equal(events.at(-1).data.status, "succeeded");
});
test("stream exhaustion returns the last error without a sixth attempt", async () => {
  let calls = 0; const error = busy(), delays: number[] = [];
  await assert.rejects(async () => {
    for await (const c of retryGenerationStream(async function* () { calls++; throw error; }, undefined, async ms => { delays.push(ms); })) assert.fail(c.text);
  }, e => e === error);
  assert.equal(calls, 5); assert.equal(delays.length, 4);
});
test("partial answers and nontransient failures are never replayed", async () => {
  for (const partial of [true, false]) {
    let calls = 0; const text: string[] = [], error = partial ? busy() : Object.assign(new Error("invalid"), { status: 401 });
    await assert.rejects(async () => {
      for await (const c of retryGenerationStream(async function* () { calls++; if (partial) yield { text: "partial" }; throw error; }, undefined, async () => { assert.fail("must not sleep"); })) text.push(c.text);
    }, e => e === error);
    assert.equal(calls, 1); assert.deepEqual(text, partial ? ["partial"] : []);
  }
});
test("Gemini stream uses identical requests on retry and records cumulative terminal usage once", async t => {
  process.env.GEMINI_API_KEY ||= "test-key";
  const { GeminiLLMService, repositoryQALLM, llmService } = await import("./llm.service.js");
  assert.equal(repositoryQALLM, llmService);
  const service = new GeminiLLMService(), requests: any[] = [], events: any[] = [], output: string[] = [];
  t.mock.method((service as any).ai.models, "generateContentStream", async (request: any) => {
    requests.push(structuredClone(request));
    return (async function* () {
      if (requests.length === 1) throw busy();
      yield { text: "hello ", usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1 } };
      yield { text: "world", usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2, thoughtsTokenCount: 3 }, candidates: [{ finishReason: "STOP" }], modelVersion: "resolved-version" };
    })();
  });
  for await (const chunk of service.stream([{ role: "system", content: "system" }, { role: "user", content: "prior" }, { role: "assistant", content: "answer" }, { role: "user", content: "current" }], e => events.push(e))) output.push(chunk.text);
  assert.deepEqual(output, ["hello ", "world"]); assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].config.httpOptions.retryOptions.attempts, 1);
  assert.equal(requests[0].config.temperature, 0.2); assert.equal(requests[0].config.systemInstruction, "system");
  assert.deepEqual(requests[0].contents.map((c: any) => c.role), ["user", "model", "user"]);
  const usage = events.find(e => e.stage === "qa.usage").data;
  assert.equal(usage.inputTokens, 20); assert.equal(usage.outputTokens, 2); assert.equal(usage.thinkingTokens, 3);
  assert.equal(usage.modelVersion, "resolved-version"); assert.equal(events.filter(e => e.stage === "generationAttempt").length, 2);
});
test("truncated Gemini generation fails without retry; absent usage stays unknown", async t => {
  process.env.GEMINI_API_KEY ||= "test-key";
  const { GeminiLLMService } = await import("./llm.service.js");
  const service = new GeminiLLMService(), events: any[] = [];
  const call = t.mock.method((service as any).ai.models, "generateContentStream", async () => (async function* () { yield { text: "partial", candidates: [{ finishReason: "MAX_TOKENS" }] }; })());
  await assert.rejects(async () => { for await (const _ of service.stream([{ role: "user", content: "q" }], e => events.push(e))) {} }, /LLM_OUTPUT_INCOMPLETE/);
  assert.equal(call.mock.callCount(), 1); assert.equal(events.find(e => e.stage === "qa.usage").data.inputTokens, null);
});
