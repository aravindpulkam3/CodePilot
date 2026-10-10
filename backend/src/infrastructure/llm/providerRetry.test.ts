import { test } from "node:test";
import assert from "node:assert/strict";
import { retryGeneration } from "./providerRetry.js";
import { Type } from "@google/genai";

test("transient overload retries with backoff and returns the first success", async () => {
  let calls = 0;
  const delays: number[] = [], events: any[] = [];
  const value = await retryGeneration(async () => {
    if (++calls < 3) throw Object.assign(new Error('busy'), { status: 503 });
    return 'ok';
  }, e => events.push(e), async ms => { delays.push(ms); });
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(events.map(e => e.data.status), ['failed', 'failed', 'succeeded']);
});

test("five total attempts preserve the last error, with no wait after exhaustion", async () => {
  const error = Object.assign(new Error('busy'), { status: 503 });
  let calls = 0;
  const delays: number[] = [], events: any[] = [];
  await assert.rejects(retryGeneration(async () => { calls++; throw error; }, e => events.push(e), async ms => { delays.push(ms); }), e => e === error);
  assert.equal(calls, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(events.at(-1).data.delayMs, 0);
});

test("authentication, quota, invalid requests and unknown failures are not retried", async () => {
  for (const status of [400, 401, 403, 404, 429, undefined]) {
    let calls = 0;
    const error = Object.assign(new Error('failed'), { status });
    await assert.rejects(retryGeneration(async () => { calls++; throw error; }, undefined, async () => { assert.fail('must not wait'); }), e => e === error);
    assert.equal(calls, 1);
  }
});

test("Gemini integration retries the same request, captures usage, and disables nested SDK retries", async t => {
  process.env.GEMINI_API_KEY ||= 'test-key';
  const { GeminiLLMService } = await import('./llm.service.js');
  const service = new GeminiLLMService();
  const requests: any[] = [], events: any[] = [];
  t.mock.method((service as any).ai.models, 'generateContent', async (request: any) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) throw Object.assign(new Error('busy'), { status: 503 });
    return { text: '{"summary":"ok"}', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, candidates: [{ finishReason: 'STOP' }] };
  });
  const result = await service.generateStructured([{ role: 'user', content: 'Review' }], { type: Type.OBJECT }, undefined, e => events.push(e));
  assert.deepEqual(result, { summary: 'ok' });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].config.httpOptions.retryOptions.attempts, 1);
  assert.equal(events.filter(e => e.stage === 'generationAttempt').length, 2);
  assert.equal(events.find(e => e.stage === 'provider').data.usage.inputTokens, 10);
});

test("Gemini malformed successful responses are not regenerated", async t => {
  process.env.GEMINI_API_KEY ||= 'test-key';
  const { GeminiLLMService } = await import('./llm.service.js');
  const service = new GeminiLLMService();
  const call = t.mock.method((service as any).ai.models, 'generateContent', async () => ({ text: 'invalid JSON' }));
  await assert.rejects(service.generateStructured([{ role: 'user', content: 'Review' }], { type: Type.OBJECT }), SyntaxError);
  assert.equal(call.mock.callCount(), 1);
});
