import { test } from "node:test";
import assert from "node:assert/strict";
import ollama from "ollama";
import { Type } from "@google/genai";
import { createRequestBudget } from "./requestBudget.js";

// Only the provider adapter is imported; every provider request below is mocked.
process.env.GEMINI_API_KEY ||= "test-key";
const { OllamaLLMService } = await import("./llm.service.js");
const messages = [{ role: "user" as const, content: "Review this change" }];
const schema = { type: Type.OBJECT, properties: { summary: { type: Type.STRING } } };

test("Ollama gets precisely the context/output budget used for assembly", async (t) => {
  let request: any;
  t.mock.method(ollama, "chat", async (value: any) => {
    request = value;
    return { done: true, done_reason: "stop", prompt_eval_count: 100, eval_count: 10, message: { content: '{"summary":"ok"}' } } as any;
  });
  const budget = createRequestBudget(16384);
  const result = await new OllamaLLMService().generateStructured(messages, schema, budget);
  assert.deepEqual(result, { summary: "ok" });
  assert.equal(request.options.num_ctx, budget.contextTokens);
  assert.equal(request.options.num_predict, budget.outputTokens);
  assert.deepEqual(request.messages, messages);
  assert.equal(request.format.type, "object");
});

test("final adapter validation prevents an oversized request from being sent", async (t) => {
  const chat = t.mock.method(ollama, "chat", async () => { throw new Error("must not call"); });
  await assert.rejects(new OllamaLLMService().generateStructured(messages, schema, createRequestBudget(100)), /REVIEW_CONTEXT_TOO_SMALL/);
  assert.equal(chat.mock.callCount(), 0);
});

test("truncated generation is rejected even if its text happens to be valid JSON", async (t) => {
  t.mock.method(ollama, "chat", async () => ({ done: true, done_reason: "length", prompt_eval_count: 100, eval_count: 4096, message: { content: '{"summary":"unfinished"}' } }) as any);
  await assert.rejects(new OllamaLLMService().generateStructured(messages, schema, createRequestBudget(16384)), /REVIEW_OUTPUT_INCOMPLETE/);
});

test("installed model limits and template are used for request accounting", async (t) => {
  t.mock.method(ollama, "show", async () => ({
    model_info: { "general.architecture": "qwen2", "qwen2.context_length": 32768 },
    parameters: "num_ctx 16384", template: "template framing", system: "", messages: [],
  }) as any);
  const previous = process.env.OLLAMA_CONTEXT_LENGTH;
  delete process.env.OLLAMA_CONTEXT_LENGTH;
  try {
    const budget = await new OllamaLLMService().getReviewBudget();
    assert.equal(budget.contextTokens, 16384);
    assert.ok(budget.safetyTokens > createRequestBudget(16384).safetyTokens);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_CONTEXT_LENGTH;
    else process.env.OLLAMA_CONTEXT_LENGTH = previous;
  }
});
