import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ContextEntryDraft,
  PromptContextSnapshot,
  capBody,
  githubBlobUrl,
  normalizeMessageSources,
  renderBackgroundEntry,
  renderNumberedSection,
  stripChunkHeader,
  toDisplaySources,
} from "./sourceRefs.js";

const codeDraft = (name: string, text: string, maxChars = 1500): ContextEntryDraft => ({
  meta: { kind: "code", filePath: `src/${name}.ts`, symbol: name, lineStart: 10, lineEnd: 20, commitSha: "abc123" },
  heading: `CODE · src/${name}.ts · ${name}`,
  text,
  maxChars,
  truncateAtLine: true,
  fenced: true,
});

describe("stripChunkHeader", () => {
  test("removes the AST chunker's header block", () => {
    const content = [
      "// File: src/auth.ts",
      "// Language: TypeScript",
      "// Type: function",
      "// Name: requireAuth",
      "// Exported: true",
      "export function requireAuth() {",
      "  return 1;",
      "}",
    ].join("\n");
    assert.equal(stripChunkHeader(content), "export function requireAuth() {\n  return 1;\n}");
  });

  test("removes the documentation chunker's header block", () => {
    const content = "// File: README.md\n// Type: documentation\n// Section: Setup > Docker\n## Docker\nRun it.";
    assert.equal(stripChunkHeader(content), "## Docker\nRun it.");
  });

  test("leaves content without a header untouched", () => {
    const content = "// just a comment\nconst x = 1;";
    assert.equal(stripChunkHeader(content), content);
  });

  test("keeps a real comment that follows the header", () => {
    const content = "// File: a.ts\n// Type: function\n// Name: f\n// explains f\nfunction f() {}";
    assert.equal(stripChunkHeader(content), "// explains f\nfunction f() {}");
  });
});

describe("capBody", () => {
  test("returns short text unchanged", () => {
    assert.deepEqual(capBody("abc", 10), { body: "abc", truncated: false });
  });

  test("cuts at a line boundary when asked", () => {
    const text = "line one\nline two\nline three";
    const { body, truncated } = capBody(text, 20, { atLine: true });
    assert.equal(truncated, true);
    assert.equal(body, "line one\nline two");
  });

  test("hard-cuts when the last line boundary would waste over half the budget", () => {
    const text = "a\n" + "x".repeat(50);
    const { body } = capBody(text, 20, { atLine: true });
    assert.equal(body.length, 20);
  });
});

describe("renderNumberedSection", () => {
  test("only rendered entries get numbers, and every [n] label has exactly one item", () => {
    const drafts = [
      codeDraft("a", "a".repeat(1400)),
      codeDraft("b", "b".repeat(1400)),
      codeDraft("c", "c".repeat(1400)),
    ];
    const { text, items, nextN } = renderNumberedSection(drafts, 3000, 4);

    assert.deepEqual(items.map((i) => i.n), [4, 5]);
    assert.equal(nextN, 6);
    const labels = [...text.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
    assert.deepEqual(labels, [4, 5]);
    assert.ok(!text.includes("c".repeat(10)), "a skipped entry must not reach the prompt");
  });

  test("skips an entry that doesn't fit instead of overflowing, with no gap in numbering", () => {
    const drafts = [
      codeDraft("big1", "x".repeat(1000)),
      codeDraft("big2", "y".repeat(1000)),
      codeDraft("small", "z".repeat(100)),
    ];
    const { items } = renderNumberedSection(drafts, 1500, 1);

    assert.deepEqual(items.map((i) => [i.n, i.symbol]), [[1, "big1"], [2, "small"]]);
    const used = items.reduce((sum, i) => sum + i.body.length, 0);
    assert.ok(used <= 1500);
  });

  test("never renders a first entry that exceeds the section budget", () => {
    const { items, text } = renderNumberedSection([codeDraft("a", "a".repeat(900), 900)], 500, 1);
    assert.equal(items.length, 0);
    assert.equal(text, "");
  });

  test("records truncation, and the body is verbatim in the rendered text", () => {
    const text = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const { items, text: rendered } = renderNumberedSection([codeDraft("long", text)], 6000, 1);

    assert.equal(items[0].truncated, true);
    assert.ok(items[0].body.length <= 1500);
    assert.ok(rendered.includes(items[0].body));
    assert.ok(rendered.includes("...[truncated]"));
    assert.ok(!items[0].body.includes("...[truncated]"));
  });
});

describe("renderBackgroundEntry", () => {
  test("is tracked but unnumbered and non-displayable", () => {
    const rendered = renderBackgroundEntry({
      meta: { kind: "summary", title: "Repository overview", summaryLevel: "repository" },
      heading: "Repository Overview",
      text: "Purpose: shortens URLs",
      maxChars: 500,
    })!;
    assert.equal(rendered.item.n, null);
    assert.equal(rendered.item.displayable, false);
    assert.ok(!/\[\d+\]/.test(rendered.text));
  });
});

describe("toDisplaySources", () => {
  const snapshot: PromptContextSnapshot = {
    version: 1,
    repoHtmlUrl: "https://github.com/acme/app",
    items: [
      { n: null, displayable: false, kind: "summary", heading: "Overview", body: "bg", truncated: false, summaryLevel: "repository" },
      { n: 2, displayable: true, kind: "code", heading: "[2] CODE", body: "skeleton", truncated: false, filePath: "src/a.ts", symbolType: "class_skeleton", lineStart: 5, lineEnd: 90, commitSha: "abc" },
      { n: 1, displayable: true, kind: "code", heading: "[1] CODE", body: "fn", truncated: false, filePath: "src/b c.ts", symbolType: "function", lineStart: 12, lineEnd: 58, commitSha: "abc" },
      { n: 3, displayable: true, kind: "summary", heading: "[3] AI SUMMARY", body: "arch", truncated: false, title: "Architecture", summaryLevel: "architecture" },
    ],
  };

  test("excludes non-displayable context and sorts by n", () => {
    assert.deepEqual(toDisplaySources(snapshot).map((s) => s.n), [1, 2, 3]);
  });

  test("derives excerptStartLine only for file-aligned code", () => {
    const [b, a] = toDisplaySources(snapshot);
    assert.equal(b.excerptStartLine, 12);
    assert.equal(a.excerptStartLine, undefined);
  });

  test("builds pinned URLs for code and never for summaries", () => {
    const [b, , arch] = toDisplaySources(snapshot);
    assert.equal(b.url, "https://github.com/acme/app/blob/abc/src/b%20c.ts#L12-L58");
    assert.equal(arch.url, undefined);
  });
});

describe("githubBlobUrl", () => {
  test("uses the plain view for markdown so line anchors work", () => {
    assert.equal(
      githubBlobUrl("https://github.com/acme/app/", "sha1", "docs/README.md", 3, 9),
      "https://github.com/acme/app/blob/sha1/docs/README.md?plain=1#L3-L9",
    );
  });

  test("returns undefined without a sha or with a non-http base", () => {
    assert.equal(githubBlobUrl("https://github.com/acme/app", undefined, "a.ts"), undefined);
    assert.equal(githubBlobUrl("javascript:alert(1)", "sha", "a.ts"), undefined);
  });
});

describe("normalizeMessageSources", () => {
  test("uses the snapshot when present (exact provenance)", () => {
    const result = normalizeMessageSources({
      promptContext: {
        version: 1,
        repoHtmlUrl: null,
        items: [{ n: 1, displayable: true, kind: "code", heading: "[1]", body: "x", truncated: false }],
      },
    });
    assert.equal(result.provenance, "exact");
    assert.deepEqual(result.sources.map((s) => s.n), [1]);
  });

  test("maps pre-provenance raw sources as legacy, stripping headers and never inventing a URL", () => {
    const result = normalizeMessageSources({
      sources: [
        { filePath: "README.md", symbolType: "documentation", sectionPath: "Setup", lineStart: 1, lineEnd: 4, content: "// File: README.md\n// Type: documentation\n// Section: Setup\nRun it.", sourceKind: "documentation" },
        { filePath: "src/a.ts", symbolType: "function", symbolName: "f", lineStart: 3, lineEnd: 9, content: "// File: src/a.ts\n// Type: function\n// Name: f\nfunction f() {}", sourceKind: "code" },
      ],
    });
    assert.equal(result.provenance, "legacy");
    assert.deepEqual(result.sources.map((s) => [s.n, s.kind]), [[1, "documentation"], [2, "code"]]);
    assert.equal(result.sources[0].section, "Setup");
    assert.equal(result.sources[1].excerpt, "function f() {}");
    assert.equal(result.sources[1].excerptStartLine, 3);
    assert.ok(result.sources.every((s) => s.url === undefined));
  });

  test("returns nothing for messages without sources", () => {
    assert.deepEqual(normalizeMessageSources({ type: "question" }), { sources: [], provenance: null });
    assert.deepEqual(normalizeMessageSources(null), { sources: [], provenance: null });
  });
});
