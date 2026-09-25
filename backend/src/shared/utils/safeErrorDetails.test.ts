import { test } from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { safeErrorDetails } from "./safeErrorDetails.js";

test("Axios diagnostics exclude credentials, config, bodies, message and stack", () => {
  const error = new AxiosError("secret in message", "ERR_BAD_RESPONSE");
  Object.assign(error, {
    config: { headers: { Authorization: "Bearer secret", Cookie: "secret" }, data: "secret request" },
    response: { status: 404, data: "secret response" },
    stack: "secret stack",
    cause: new Error("secret cause"),
  });
  assert.deepEqual(safeErrorDetails(error), { code: "ERR_BAD_RESPONSE", status: 404 });
  assert.ok(!JSON.stringify(safeErrorDetails(error)).includes("secret"));
});

test("database/network codes remain useful without logging raw error objects", () => {
  assert.deepEqual(safeErrorDetails({ code: "23505", detail: "private row" }), { code: "23505" });
  assert.deepEqual(safeErrorDetails({ code: "ECONNRESET" }), { code: "ECONNRESET" });
  for (const value of [null, undefined, "private message", { code: {}, status: "private" }, { code: "Bearer secret", status: 900 }]) {
    assert.deepEqual(safeErrorDetails(value), {});
  }
});
