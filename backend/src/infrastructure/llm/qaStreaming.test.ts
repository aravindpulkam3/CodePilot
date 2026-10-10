import { after, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const requests: any[] = [];
(globalThis as any).__qaOllama = { async chat(request: any) { requests.push(structuredClone(request)); return (async function* () { yield { message: { content: "answer" }, done: false }; yield { message: { content: "" }, done: true, prompt_eval_count: 100, eval_count: 2, done_reason: "stop", total_duration: 50 }; })(); } };
const mocks: Record<string, string> = { ollama: "export default globalThis.__qaOllama;", "@google/genai": "export class GoogleGenAI{}; export const Type={};", dotenv: "export default {config(){}};" };
const hooks = registerHooks({ resolve(specifier, context, next) { return mocks[specifier] ? { url: "data:text/javascript," + encodeURIComponent(mocks[specifier]), shortCircuit: true } : next(specifier, context); } });
const { ollamaService } = await import("./llm.service.js"); hooks.deregister();
after(() => { delete (globalThis as any).__qaOllama; });
test("stream diagnostics retain production request settings and text, recording actual terminal usage", async () => {
  const messages = [{ role: "user" as const, content: "question" }], plain: any[] = [], observed: any[] = [], events: any[] = [];
  for await (const chunk of ollamaService.stream(messages)) plain.push(chunk);
  for await (const chunk of ollamaService.stream(messages, e => { events.push(structuredClone(e)); e.data.inputTokens = 0; })) observed.push(chunk);
  assert.deepEqual(observed, plain); assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[0], { model: "qwen2.5-coder:7b", messages, stream: true, options: { temperature: 0.2 } });
  assert.equal(events[0].data.inputTokens, 100); assert.equal(events[0].data.outputTokens, 2);
  assert.equal(events[0].data.doneReason, "stop");
});
