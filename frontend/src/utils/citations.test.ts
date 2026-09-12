import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveCitation, splitCitations, type CitationToken } from "./citations.ts";

const tokens = (text: string) =>
  splitCitations(text).filter((s): s is CitationToken => typeof s !== "string");

const exactSources = [
  { n: 1, kind: "summary" },
  { n: 2, kind: "documentation" },
  { n: 3, kind: "code" },
  { n: 4, kind: "code" },
];

describe("splitCitations", () => {
  test("parses a single numeric citation and keeps the surrounding text", () => {
    const segments = splitCitations("Validated by requireAuth [3].");
    assert.deepEqual(segments[0], "Validated by requireAuth ");
    assert.deepEqual(segments[1], { raw: "[3]", refs: [{ type: "number", n: 3 }] });
    assert.deepEqual(segments[2], ".");
  });

  test("parses comma lists and merges adjacent brackets into one token", () => {
    assert.deepEqual(tokens("see [1, 3]")[0].refs.map((r) => (r as any).n), [1, 3]);
    const merged = tokens("see [1][3] here");
    assert.equal(merged.length, 1);
    assert.equal(merged[0].raw, "[1][3]");
  });

  test("ignores array indexing and markdown links", () => {
    assert.equal(tokens("items[0] and arr[2]").length, 0);
    assert.equal(tokens("a [1](https://example.com) link").length, 0);
  });

  test("parses legacy [Source N] / [Doc N] labels", () => {
    const [source, doc] = tokens("code [Source 2] and docs [doc 1]");
    assert.deepEqual(source.refs, [{ type: "legacy", kind: "code", index: 2 }]);
    assert.deepEqual(doc.refs, [{ type: "legacy", kind: "documentation", index: 1 }]);
  });

  test("returns plain text untouched when there are no citations", () => {
    assert.deepEqual(splitCitations("no citations here"), ["no citations here"]);
  });
});

describe("resolveCitation", () => {
  test("resolves numbers that belong to this message's sources", () => {
    const [token] = tokens("[1, 3]");
    assert.deepEqual(resolveCitation(token, exactSources, "exact"), [
      { label: "1", n: 1 },
      { label: "3", n: 3 },
    ]);
  });

  test("never links a number with no matching source", () => {
    const [token] = tokens("[9]");
    assert.deepEqual(resolveCitation(token, exactSources, "exact"), [{ label: "9", n: null }]);
  });

  test("collapses duplicate references", () => {
    const [token] = tokens("[3][3]");
    assert.deepEqual(resolveCitation(token, exactSources, "exact"), [{ label: "3", n: 3 }]);
  });

  test("legacy labels resolve by position among that kind, only for legacy messages", () => {
    const legacySources = [
      { n: 1, kind: "documentation" },
      { n: 2, kind: "code" },
      { n: 3, kind: "code" },
    ];
    const [source2] = tokens("[Source 2]");
    const [doc1] = tokens("[Doc 1]");
    assert.deepEqual(resolveCitation(source2, legacySources, "legacy"), [{ label: "3", n: 3 }]);
    assert.deepEqual(resolveCitation(doc1, legacySources, "legacy"), [{ label: "1", n: 1 }]);
    assert.deepEqual(resolveCitation(source2, legacySources, "exact"), [{ label: "Source 2", n: null }]);
  });

  test("numeric citations are never linked in legacy messages", () => {
    const [token] = tokens("[2]");
    assert.deepEqual(resolveCitation(token, [{ n: 2, kind: "code" }], "legacy"), [{ label: "2", n: null }]);
  });
});
