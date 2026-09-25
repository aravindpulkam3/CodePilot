import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type Request, type Response } from "express";
import { errorHandler } from "./errorHandler.js";

test("real JSON parser failures keep 400/413 and unexpected errors stay private", async (t) => {
  t.mock.method(console, "error", () => {});
  const app = express();
  app.use(express.json());
  app.post("/", (_req, res) => { res.json({ ok: true }); });
  app.get("/failure", () => { throw new Error("SQL connection failed at private-host:5432"); });
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    for (const [body, status, message] of [
      ['{"broken":', 400, "Malformed JSON body"],
      [JSON.stringify({ content: "a".repeat(103_000) }), 413, "Request body too large"],
    ] as const) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: message });
    }
    const response = await fetch(url + "/failure");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("headers already sent delegate the original failure without another response", () => {
  const error = new Error("stream failure");
  let delegated: unknown;
  errorHandler(error, {} as Request, { headersSent: true } as Response, value => { delegated = value; });
  assert.equal(delegated, error);
});
