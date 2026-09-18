import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildQAPromptContext, QAPromptContextInput } from "./qaPromptContext.js";
import type { CodeChunkSearchResult, DocChunkSearchResult } from "../../../infrastructure/retrieval/retrievalTypes.js";

const code = (name: string, body: string, overrides: Partial<CodeChunkSearchResult> = {}): CodeChunkSearchResult => ({
  filePath: `src/${name}.ts`,
  symbolName: name,
  symbolType: "function",
  content: `// File: src/${name}.ts\n// Language: TypeScript\n// Type: function\n// Name: ${name}\n${body}`,
  lineStart: 10,
  lineEnd: 20,
  similarity: 0.8,
  commitSha: "sha-code",
  ...overrides,
});

const doc = (section: string, body: string): DocChunkSearchResult => ({
  filePath: "README.md",
  symbolName: section,
  symbolType: "documentation",
  sectionPath: section,
  content: `// File: README.md\n// Type: documentation\n// Section: ${section}\n${body}`,
  lineStart: 1,
  lineEnd: 5,
  similarity: 0.7,
  commitSha: "sha-doc",
});

const base = (overrides: Partial<QAPromptContextInput> = {}): QAPromptContextInput => ({
  repositoryProfile: "Purpose: A URL shortener\nFeature modules (by file count): Auth (3), Api (2)\nDependencies (package.json): express",
  repositoryTier: "full",
  docChunks: [doc("Setup", "Run docker compose up.")],
  docTier: "full",
  codeChunks: [code("requireAuth", "export function requireAuth() {}"), code("login", "export function login() {}")],
  codeTier: "full",
  graphNeighbors: { anchorFile: "src/requireAuth.ts", dependencies: ["src/db.ts"], dependents: ["src/app.ts"] },
  ...overrides,
});

describe("buildQAPromptContext", () => {
  test("numbers every citable entry continuously in prompt order", () => {
    const { items, promptText } = buildQAPromptContext(base());
    const numbered = items.filter((i) => i.displayable);

    assert.deepEqual(
      numbered.map((i) => [i.n, i.kind]),
      [
        [1, "documentation"],
        [2, "code"],
        [3, "code"],
        [4, "imports"],
      ],
    );
    const labels = [...promptText.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
    assert.deepEqual(labels, [1, 2, 3, 4]);
    assert.ok(!/AI SUMMARY/.test(promptText), "no AI summary sections remain");
  });

  test("keeps the repository overview as unnumbered, non-displayable background", () => {
    const { items, promptText } = buildQAPromptContext(base());
    const overview = items.find((i) => i.summaryLevel === "repository")!;

    assert.equal(overview.n, null);
    assert.equal(overview.displayable, false);
    const overviewSection = promptText.split("\n\n")[0];
    assert.match(overviewSection, /Repository Overview/);
    assert.ok(!/\[\d+\]/.test(overviewSection));
  });

  test("omitted tiers produce no items and no prompt text", () => {
    const { items, promptText } = buildQAPromptContext(
      base({ repositoryTier: "omit", docTier: "omit", codeTier: "omit", graphNeighbors: null }),
    );
    assert.equal(items.length, 0);
    assert.equal(promptText, "");
  });

  test("strips synthetic headers and every body appears verbatim in the prompt", () => {
    const { items, promptText } = buildQAPromptContext(base());
    for (const item of items) {
      assert.ok(promptText.includes(item.body), `body of ${item.heading} missing from prompt`);
      assert.ok(!item.body.startsWith("// File:"), `header leaked into ${item.heading}`);
    }
  });

  test("the repository profile is capped to its tier budget", () => {
    const long = "word ".repeat(400);
    const { items } = buildQAPromptContext(base({ repositoryProfile: long, repositoryTier: "reduced" }));
    const overview = items.find((i) => i.summaryLevel === "repository")!;
    assert.equal(overview.truncated, true);
    assert.equal(overview.body.length <= 500, true);
  });

  test("no profile text means no overview entry", () => {
    const { items } = buildQAPromptContext(base({ repositoryProfile: null }));
    assert.equal(items.some((i) => i.summaryLevel === "repository"), false);
  });

  test("reduced code budget drops what doesn't fit rather than listing it", () => {
    const bodies = ["a", "b", "c"].map((c) => (c + "\n").repeat(700));
    const { items } = buildQAPromptContext(
      base({ codeChunks: bodies.map((b, i) => code(`f${i}`, b)), codeTier: "reduced", graphNeighbors: null }),
    );
    const codeItems = items.filter((i) => i.kind === "code");
    assert.ok(codeItems.length < 3);
    assert.ok(codeItems.reduce((s, i) => s + i.body.length, 0) <= 2500);
  });

  test("propagates the indexed commit sha", () => {
    const { items } = buildQAPromptContext(base());
    assert.equal(items.find((i) => i.kind === "code")!.commitSha, "sha-code");
    assert.equal(items.find((i) => i.kind === "documentation")!.commitSha, "sha-doc");
  });
});
