import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildDocumentationQuery } from "./documentationQuery.js";

describe("buildDocumentationQuery", () => {
  test("uses title and description, and excludes file paths entirely", () => {
    const q = buildDocumentationQuery(
      "Tighten the rate limiter to 20 requests per minute",
      "The previous limit let bursts through.",
      ["backend/src/middleware/rateLimiter.js", "backend/src/server.js"],
    )!;

    assert.match(q, /rate limiter/i);
    assert.match(q, /previous limit/i);
    // The whole point: path text is what dragged retrieval toward the
    // README's file-tree section.
    assert.ok(!q.includes("backend/src"), `paths leaked into the query: ${q}`);
    assert.ok(!q.includes("/"), `path separators leaked: ${q}`);
  });

  test("title alone is enough when it carries real content", () => {
    const q = buildDocumentationQuery("Switch authentication from sessions to JWT", "", []);
    assert.match(q!, /authentication/i);
  });

  test("falls back to basenames — not full paths — when prose is thin", () => {
    const q = buildDocumentationQuery("fix", "", [
      "backend/src/services/authentication.service.ts",
      "backend/src/controllers/session.controller.ts",
    ])!;

    assert.match(q, /authentication\.service/);
    assert.match(q, /session\.controller/);
    assert.ok(!q.includes("backend/src"), `directories leaked: ${q}`);
  });

  test("returns null when there is nothing meaningful to search on", () => {
    // A contentless query does not return "no results" — it returns whatever
    // section is nearest the origin, which is how "fix bug" ended up matched
    // against the Installation section. Skipping is the correct behaviour.
    assert.equal(buildDocumentationQuery("fix", "", []), null);
    assert.equal(buildDocumentationQuery("", "", []), null);
    assert.equal(buildDocumentationQuery(null, undefined, []), null);
    assert.equal(buildDocumentationQuery("wip", "", ["a.ts"]), null);
  });

  test("strips template comments, issue refs, URLs and markdown markers", () => {
    const q = buildDocumentationQuery(
      "chore",
      "<!-- Describe your changes -->\n## Summary\n- [ ] Tests added\nCloses #42\nhttps://example.com/issue/42",
      [],
    )!;

    assert.ok(!q.includes("<!--"), `html comment survived: ${q}`);
    assert.ok(!q.includes("http"), `url survived: ${q}`);
    assert.ok(!/#42/.test(q), `issue ref survived: ${q}`);
    assert.ok(!q.includes("[ ]"), `checklist marker survived: ${q}`);
    assert.ok(!q.includes("##"), `heading marker survived: ${q}`);

    // KNOWN LIMIT, asserted so it's a decision rather than a surprise: the
    // *text* of a filled-in template ("Tests added") survives and can clear
    // the length bar. Classifying boilerplate-vs-real checklist content is not
    // reliably possible — the test above proves real content must survive —
    // so a template-only description yields a weak-but-nonempty query. The
    // 0.6 similarity floor is what stops that returning anything useless.
    assert.ok(q.length > 0);
  });

  test("keeps real prose that happens to contain a checklist", () => {
    const q = buildDocumentationQuery(
      "Add Redis-backed rate limiting to the shortener API",
      "- [x] Implemented sliding window counters",
      [],
    )!;
    assert.match(q, /rate limiting/i);
    assert.match(q, /sliding window/i);
    assert.ok(!q.includes("[x]"));
  });

  test("windows-style paths are normalised before taking basenames", () => {
    const q = buildDocumentationQuery("fix", "", [
      "backend\\src\\services\\authentication.service.ts",
    ])!;
    assert.match(q, /authentication\.service/);
    assert.ok(!q.includes("\\"));
  });
});
