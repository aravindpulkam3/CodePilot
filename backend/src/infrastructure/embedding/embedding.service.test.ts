import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { ChunkMetadata } from "../chunking/astChunking.service.js";

// Prevent Redis initialization; generation tests never need the query cache.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../../shared/utils/cache.js") return {
    url: "data:text/javascript,export const withCache = async (_key, _ttl, fetcher) => fetcher();", shortCircuit: true,
  };
  return next(specifier, context);
} });
process.env.GOOGLE_API_KEY ||= "test-key";
const { EmbeddingService } = await import("./embedding.service.js");
hooks.deregister();
const chunk = (name: string): ChunkMetadata => ({ file_path: "a.ts", language: "TypeScript", symbol_type: "function", symbol_name: name,
  start_line: 1, end_line: 2, content: name, content_hash: name });
const vector = (value = 0.25) => Array(3072).fill(value);

describe("complete embedding batches", () => {
  test("complete response maps in documented request order and preserves source metadata", async (t) => {
    const service = new EmbeddingService();
    const inputs = [chunk("first"), chunk("second")];
    const response = { embeddings: [{ values: vector(0.1) }, { values: vector(0.2) }] };
    const call = t.mock.method((service as any).ai.models, "embedContent", async (request: any) => {
      assert.deepEqual(request.contents, ["first", "second"]);
      assert.equal(request.model, "gemini-embedding-001");
      assert.equal(request.config.taskType, "RETRIEVAL_DOCUMENT");
      return response;
    });
    const result = await service.generateEmbeddings(inputs);
    assert.deepEqual(result, inputs.map((item, i) => ({ ...item, embedding: response.embeddings[i].values })));
    assert.equal(call.mock.callCount(), 1);
  });
  test("empty input makes no provider call", async (t) => {
    const service = new EmbeddingService();
    const call = t.mock.method((service as any).ai.models, "embedContent", async () => { throw new Error("unexpected call"); });
    assert.deepEqual(await service.generateEmbeddings([]), []);
    assert.equal(call.mock.callCount(), 0);
  });
  const cases: Array<[string, unknown]> = [
    ["missing response", undefined], ["missing array", {}], ["non-array", { embeddings: {} }],
    ["fewer vectors", { embeddings: [{ values: vector() }] }],
    ["extra vectors", { embeddings: Array.from({ length: 3 }, () => ({ values: vector() })) }],
    ["missing vector", { embeddings: [{ values: vector() }, {}] }],
    ["missing entry", { embeddings: [{ values: vector() }, null] }],
    ["wrong dimensions", { embeddings: [{ values: vector() }, { values: [1, 2] }] }],
    ["non-array vector", { embeddings: [{ values: vector() }, { values: { length: 3072 } }] }],
    ...[NaN, Infinity, -Infinity, "0.5", null, undefined].map((invalid) => [String(invalid), { embeddings: [{ values: vector() }, { values: [...vector().slice(1), invalid] }] }] as [string, unknown]),
    ["sparse vector", { embeddings: [{ values: vector() }, { values: new Array(3072) }] }],
    ["sparse response", { embeddings: new Array(2) }],
  ];
  for (const [name, response] of cases) test("rejects " + name + " without returning a partial batch", async (t) => {
    const service = new EmbeddingService();
    t.mock.method((service as any).ai.models, "embedContent", async () => response);
    await assert.rejects(service.generateEmbeddings([chunk("a"), chunk("b")]), /Embedding response count|Invalid embedding/);
  });
  test("a failed attempt can be retried without retaining partial results", async (t) => {
    const service = new EmbeddingService(); let attempts = 0;
    t.mock.method((service as any).ai.models, "embedContent", async () => ++attempts === 1
      ? { embeddings: [] } : { embeddings: [{ values: vector() }] });
    await assert.rejects(service.generateEmbeddings([chunk("a")]));
    assert.equal((await service.generateEmbeddings([chunk("a")])).length, 1);
    assert.equal(attempts, 2);
  });
});
