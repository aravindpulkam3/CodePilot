import { test, describe } from "node:test";
import type { EnclosingChunk } from "./changedCodeContext.js";
import assert from "node:assert/strict";
import type { ChunkMetadata } from "../../infrastructure/chunking/astChunking.service.js";
import {
  buildChangedCodeContext,
  CHANGED_CODE_LIMITS,
  parseChangedLines,
  selectEnclosingChunks,
  unmappedTargets,
  changedSourceTargets,
  uncoveredTargets,
  includedTargets,
  verifyPatchAgainstContent,
  type ChangedCodeDeps,
} from "./changedCodeContext.js";

const chunk = (start: number, end: number, name: string, symbolType = "function", body = `${name} body`): ChunkMetadata => ({
  file_path: "f.ts",
  language: "TypeScript",
  symbol_type: symbolType,
  symbol_name: name,
  qualified_name: name,
  start_line: start,
  end_line: end,
  content: `// File: f.ts\n// Type: ${symbolType}\n// Name: ${name}\n${body}`,
  content_hash: `${name}-${start}`,
  source_spans: symbolType === "class_skeleton" ? [] : [{ start: DB_HEAD.split("\n").slice(0, start - 1).join("\n").length + (start > 1 ? 1 : 0), end: DB_HEAD.split("\n").slice(0, end).join("\n").length }],
});

// url-shortener@708fcdbf config/db.js — the real GitHub patch.
const DB_PATCH = [
  "@@ -1,13 +1,13 @@",
  ' import mongoose from "mongoose";',
  " ",
  "-const connectDB = async () => {",
  "+async function connectDB() {",
  "   try {",
  "     await mongoose.connect(process.env.MONGO_URI);",
  '     console.log("MongoDB connected");',
  "   } catch (err) {",
  "     console.log(err.message);",
  "     process.exit(1);",
  "   }",
  "-};",
  "+}",
  " ",
  " export default connectDB;",
].join("\n");

const DB_HEAD = [
  'import mongoose from "mongoose";',
  "",
  "async function connectDB() {",
  "  try {",
  "    await mongoose.connect(process.env.MONGO_URI);",
  '    console.log("MongoDB connected");',
  "  } catch (err) {",
  "    console.log(err.message);",
  "    process.exit(1);",
  "  }",
  "}",
  "",
  "export default connectDB;",
  "",
].join("\n");

describe("parseChangedLines", () => {
  test("records added and context lines with head line numbers; context is never 'changed'", () => {
    const p = parseChangedLines(DB_PATCH);
    assert.deepEqual(p.added.map((a) => a.line), [3, 11]);
    assert.deepEqual(p.addedRuns, [{ start: 3, end: 3 }, { start: 11, end: 11 }]);
    assert.equal(p.context.length, 11);
    assert.deepEqual(p.context.slice(0, 2).map((c) => c.line), [1, 2]);
    // Both "-" lines are REPLACED by "+" lines: modifications, not deletions.
    assert.deepEqual(p.deletionAnchors, []);
  });

  test("only a pure deletion block gets an anchor; a replacement does not", () => {
    const p = parseChangedLines(
      ["@@ -1,6 +1,6 @@", " a", "-old", "+new", " b", "-gone", " c", "-x", "+y", "+z"].join("\n"),
    );
    assert.deepEqual(p.deletionAnchors, [4]);
    assert.deepEqual(p.addedRuns, [{ start: 2, end: 2 }, { start: 5, end: 6 }]);
  });

  test("handles multiple hunks and the no-count @@ form", () => {
    const p = parseChangedLines(["@@ -3 +3 @@", "-old", "+new", "@@ -20,2 +20,3 @@", " a", "+b", " c"].join("\n"));
    assert.deepEqual(p.added.map((a) => [a.line, a.text]), [[3, "new"], [21, "b"]]);
    assert.deepEqual(p.context.map((c) => c.line), [20, 22]);
  });

  test("a +c,0 pure-deletion hunk yields an anchor and no added lines", () => {
    const p = parseChangedLines(["@@ -10,4 +10,2 @@", " keep1", "-gone1", "-gone2", " keep2"].join("\n"));
    assert.deepEqual(p.added, []);
    assert.deepEqual(p.deletionAnchors, [11]);
    assert.deepEqual(p.context.map((c) => c.line), [10, 11]);
  });

  test("ignores '\\ No newline at end of file' and everything before the first @@", () => {
    const gitShow = [
      "diff --git a/x.js b/x.js",
      "index 000..111 100644",
      "--- a/x.js",
      "+++ b/x.js",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const p = parseChangedLines(gitShow);
    assert.deepEqual(p.added.map((a) => a.text), ["line one", "line two"]);
    assert.deepEqual(p.context, [], "the trailing empty line is outside the hunk");
  });
});

describe("verifyPatchAgainstContent", () => {
  test("accepts the real patch against its real head content", () => {
    assert.equal(verifyPatchAgainstContent(parseChangedLines(DB_PATCH), DB_HEAD), "ok");
  });

  test("a mismatch on only the LAST added line is still a mismatch", () => {
    const p = parseChangedLines(["@@ -1,1 +1,3 @@", " a", "+b", "+c"].join("\n"));
    assert.equal(verifyPatchAgainstContent(p, "a\nb\nDIFFERENT\n"), "line-mismatch");
  });

  test("a mismatch on a context line only is a mismatch", () => {
    const p = parseChangedLines(["@@ -1,2 +1,3 @@", " a", "+b", " c"].join("\n"));
    assert.equal(verifyPatchAgainstContent(p, "a\nb\nNOT-C\n"), "line-mismatch");
  });

  test("a deletion-only hunk with changed surrounding context is never trusted", () => {
    const p = parseChangedLines(["@@ -1,3 +1,2 @@", " before", "-removed", " after"].join("\n"));
    assert.equal(verifyPatchAgainstContent(p, "before\nafter\n"), "ok");
    assert.equal(verifyPatchAgainstContent(p, "before\nshifted\nafter\n"), "line-mismatch");
  });

  test("a patch with only removed lines is unverifiable", () => {
    const p = parseChangedLines(["@@ -1,2 +0,0 @@", "-x", "-y"].join("\n"));
    assert.equal(verifyPatchAgainstContent(p, "whatever"), "unverifiable");
  });

  test("CRLF on one side and LF on the other compare equal", () => {
    const p = parseChangedLines(["@@ -1,1 +1,2 @@", " a\r", "+b\r"].join("\n"));
    assert.equal(verifyPatchAgainstContent(p, "a\nb\n"), "ok");
    const q = parseChangedLines(["@@ -1,1 +1,2 @@", " a", "+b"].join("\n"));
    assert.equal(verifyPatchAgainstContent(q, "a\r\nb\r\n"), "ok");
  });
});

describe("selectEnclosingChunks / unmappedTargets", () => {
  const fileChunks = [
    chunk(1, 2, "imports", "module_top_level"),
    chunk(4, 10, "alpha"),
    chunk(12, 20, "beta"),
  ];
  const patchAdding = (lines: number[]) => ({ added: lines.map((line) => ({ line, text: "" })), context: [], addedRuns: lines.map((l) => ({ start: l, end: l })), deletionAnchors: [] as number[] });

  test("an added run inside a method returns that method, not its neighbour", () => {
    const sel = selectEnclosingChunks(fileChunks, patchAdding([6]));
    assert.deepEqual(sel.map((c) => c.symbol_name), ["alpha"]);
  });

  test("a run spanning two symbols returns both", () => {
    const p = { ...patchAdding([]), addedRuns: [{ start: 9, end: 13 }] };
    assert.deepEqual(selectEnclosingChunks(fileChunks, p).map((c) => c.symbol_name), ["alpha", "beta"]);
  });

  test("a changed import line returns the top-level chunk", () => {
    assert.deepEqual(selectEnclosingChunks(fileChunks, patchAdding([1])).map((c) => c.symbol_name), ["imports"]);
  });

  test("a split symbol returns only the overlapping parts", () => {
    const parts = [chunk(1, 50, "big (part 1/3)"), chunk(51, 100, "big (part 2/3)"), chunk(101, 150, "big (part 3/3)")];
    assert.deepEqual(selectEnclosingChunks(parts, patchAdding([120])).map((c) => c.symbol_name), ["big (part 3/3)"]);
  });

  test("a deletion inside a surviving body is enclosed; one between symbols is not", () => {
    const inside = { ...patchAdding([]), deletionAnchors: [7] };
    assert.deepEqual(selectEnclosingChunks(fileChunks, inside).map((c) => c.symbol_name), ["alpha"]);
    const between = { ...patchAdding([]), deletionAnchors: [12] }; // lines 11 and 12 straddle alpha/beta
    assert.deepEqual(selectEnclosingChunks(fileChunks, between), []);
    assert.deepEqual(unmappedTargets(fileChunks, between, [], DB_HEAD), ["deletion before line 12"]);
  });

  test("a class skeleton never stands in for the method that actually contains the change", () => {
    const cls = [chunk(1, 100, "Big", "class_skeleton"), chunk(10, 20, "Big.method", "method"), chunk(30, 40, "Big.other", "method")];
    assert.deepEqual(selectEnclosingChunks(cls, patchAdding([15])).map((c) => c.symbol_name), ["Big.method", "Big"]);
    // A field line no member covers maps to the skeleton.
    assert.deepEqual(selectEnclosingChunks(cls, patchAdding([5])).map((c) => c.symbol_name), ["Big"]);
    // If the method chunk is not kept, the skeleton does NOT count as covering its lines.
    assert.deepEqual(unmappedTargets(cls, patchAdding([15]), [cls[0]], DB_HEAD), ["added lines 15-15"]);
  });

  test("more than four relevant chunks remain candidates", () => {
    const many = Array.from({ length: 6 }, (_, i) => chunk(i * 10 + 1, i * 10 + 9, 'fn' + i));
    assert.equal(selectEnclosingChunks(many, patchAdding([5, 15, 25, 35, 45, 55])).length, 6);
  });

});

const stubDeps = (files: Record<string, string | Error | null>, chunksFor: (path: string) => ChunkMetadata[] | Error): ChangedCodeDeps => ({
  fetchContent: async (path) => {
    const v = files[path];
    if (v instanceof Error) throw v;
    return v ?? null;
  },
  chunkFile: async (path) => {
    const v = chunksFor(path);
    if (v instanceof Error) throw v;
    return v;
  },
  supportsFile: (path) => /\.(ts|js)$/.test(path),
});

describe("buildChangedCodeContext", () => {
  const dbChunks = [chunk(1, 1, "db.js (top-level)", "module_top_level"), chunk(3, 11, "connectDB"), chunk(13, 13, "db.js (top-level)", "module_top_level")];

  test("guaranteed coverage puts the file in fullyHeadCoveredFiles, with header-stripped content", async () => {
    const ctx = await buildChangedCodeContext(
      { headSha: "708fcdbf", files: [{ filename: "config/db.js", status: "modified", patch: DB_PATCH }] },
      stubDeps({ "config/db.js": DB_HEAD }, () => dbChunks),
    );
    assert.equal(ctx.files[0].coverage, "guaranteed");
    assert.deepEqual(ctx.files[0].chunks.map((c) => c.qualifiedName), ["connectDB"]);
    assert.equal(ctx.files[0].chunks[0].content, DB_HEAD.split("\n").slice(2, 11).join("\n"));
    assert.deepEqual(ctx.fullyHeadCoveredFiles, ["config/db.js"]);
  });

  test("partial coverage attaches what mapped but is NOT fully covered", async () => {
    // Line 11's run maps to nothing when connectDB is only 3-10 in this head.
    const ctx = await buildChangedCodeContext(
      { headSha: "h", files: [{ filename: "config/db.js", status: "modified", patch: DB_PATCH }] },
      stubDeps({ "config/db.js": DB_HEAD }, () => [chunk(3, 10, "connectDB")]),
    );
    assert.equal(ctx.files[0].coverage, "partial");
    assert.equal(ctx.files[0].chunks.length, 1);
    assert.ok(ctx.files[0].unmapped.includes("added lines 11-11"));
    assert.deepEqual(ctx.fullyHeadCoveredFiles, []);
  });

  test("every fallback reason attaches nothing and is never fully covered; one file's failure never affects another", async () => {
    const ok = { filename: "config/db.js", status: "modified", patch: DB_PATCH };
    const ctx = await buildChangedCodeContext(
      {
        headSha: "h",
        files: [
          { filename: "a.ts", status: "modified", patch: "" },
          { filename: "b.ts", status: "removed", patch: "@@ -1,1 +0,0 @@\n-x" },
          { filename: "package.json", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
          { filename: "throws.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
          { filename: "missing.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
          { filename: "stale.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
          { filename: "unparseable.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" },
          { filename: "only-removed.ts", status: "modified", patch: "@@ -1,2 +0,0 @@\n-x\n-y" },
          ok,
        ],
      },
      stubDeps(
        {
          "throws.ts": new Error("rate limited"),
          "missing.ts": null,
          "stale.ts": "a\n",
          "unparseable.ts": "b\n",
          "only-removed.ts": "",
          "config/db.js": DB_HEAD,
        },
        (path) => (path === "unparseable.ts" ? new Error("parse") : path === "config/db.js" ? dbChunks : []),
      ),
    );
    const byFile = Object.fromEntries(ctx.files.map((f) => [f.filename, f.coverage]));
    assert.deepEqual(byFile, {
      "a.ts": "fallback:no-patch",
      "b.ts": "fallback:removed",
      "package.json": "fallback:unsupported",
      "throws.ts": "fallback:fetch-failed",
      "missing.ts": "fallback:fetch-failed",
      "stale.ts": "fallback:line-mismatch",
      "unparseable.ts": "fallback:parse-failed",
      "only-removed.ts": "fallback:unverifiable",
      "config/db.js": "guaranteed",
    });
    assert.ok(ctx.files.filter((f) => f.coverage.startsWith("fallback:")).every((f) => f.chunks.length === 0));
    assert.deepEqual(ctx.fullyHeadCoveredFiles, ["config/db.js"]);
  });

  test("candidate resource ceilings are explicit and do not block a later small candidate", async () => {
    const patch = "@@ -1 +1 @@\n-a\n+b";
    const huge = chunk(1, 1, "huge", "function", "x".repeat(CHANGED_CODE_LIMITS.maxCandidateCharsPerFile + 1));
    const ctx = await buildChangedCodeContext({ headSha: "h", files: [{ filename: "f.ts", status: "modified", patch }] },
      stubDeps({ "f.ts": "b\n" }, () => [huge, chunk(1, 1, "small")]));
    assert.equal(ctx.files[0].candidateLimitReached, true);
    assert.deepEqual(ctx.files[0].chunks.map((c) => c.symbolName), ["small"]);
  });

  test("files beyond the file cap fall back", async () => {
    const files = Array.from({ length: CHANGED_CODE_LIMITS.maxFiles + 1 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }));
    const contents = Object.fromEntries(files.map((f) => [f.filename, "b\n"]));
    const ctx = await buildChangedCodeContext({ headSha: "h", files }, stubDeps(contents, (p) => [chunk(1, 1, p)]));
    assert.equal(ctx.files[CHANGED_CODE_LIMITS.maxFiles].coverage, "fallback:over-file-cap");
    assert.equal(ctx.fullyHeadCoveredFiles.length, CHANGED_CODE_LIMITS.maxFiles);
  });
});

const sourceChunk = (start: number, end: number): EnclosingChunk => ({
  qualifiedName: "fn", symbolName: "fn", symbolType: "function", startLine: 1, endLine: 100,
  content: "source", sourceSpans: [{ start, end }],
});

describe("actual retained source coverage", () => {
  test("a contiguous six-line run is not covered by its first four enclosing chunks", () => {
    const source = "a\nb\nc\nd\ne\nf";
    const patch = "@@ -0,0 +1,6 @@\n+a\n+b\n+c\n+d\n+e\n+f";
    const targets = changedSourceTargets(parseChangedLines(patch), source);
    const chunks = Array.from({ length: 6 }, (_, i) => sourceChunk(i * 2, i * 2 + 1));
    assert.deepEqual(uncoveredTargets(targets, chunks.slice(0, 4)), ["added lines 1-6"]);
    assert.deepEqual(uncoveredTargets(targets, chunks), []);
  });

  test("one contiguous run spanning six parts is incomplete with four or one retained", () => {
    const source = "abcdef";
    const targets = changedSourceTargets(parseChangedLines("@@ -0,0 +1 @@\n+abcdef"), source);
    const chunks = Array.from({ length: 6 }, (_, i) => sourceChunk(i, i + 1));
    assert.deepEqual(uncoveredTargets(targets, chunks.slice(0, 4)), ["added lines 1-1"]);
    assert.deepEqual(uncoveredTargets(targets, chunks.slice(0, 1)), ["added lines 1-1"]);
    assert.deepEqual(uncoveredTargets(targets, chunks), []);
  });

  test("overlap and adjacency cover a target; a one-character gap does not", () => {
    const targets = changedSourceTargets(parseChangedLines("@@ -0,0 +1 @@\n+abcdef"), "abcdef");
    assert.deepEqual(uncoveredTargets(targets, [sourceChunk(0, 4), sourceChunk(2, 6)]), []);
    assert.deepEqual(uncoveredTargets(targets, [sourceChunk(0, 3), sourceChunk(3, 6)]), []);
    assert.deepEqual(uncoveredTargets(targets, [sourceChunk(0, 3), sourceChunk(4, 6)]), ["added lines 1-1"]);
  });

  test("synthetic skeleton and noncontiguous member ranges cannot fill source gaps", () => {
    const targets = changedSourceTargets(parseChangedLines("@@ -0,0 +1 @@\n+abcdef"), "abcdef");
    const group = { ...sourceChunk(0, 6), symbolType: "class_member_group", sourceSpans: [{ start: 0, end: 2 }, { start: 4, end: 6 }] };
    const skeleton = { ...sourceChunk(0, 6), symbolType: "class_skeleton", sourceSpans: [] };
    assert.deepEqual(uncoveredTargets(targets, [group, skeleton]), ["added lines 1-1"]);
  });

  test("deletion requires one source interval enclosing both sides", () => {
    const targets = changedSourceTargets(parseChangedLines("@@ -1,3 +1,2 @@\n a\n-gone\n b"), "a\nb");
    assert.deepEqual(uncoveredTargets(targets, [sourceChunk(0, 2), sourceChunk(2, 3)]), ["deletion before line 2"]);
    assert.deepEqual(uncoveredTargets(targets, [sourceChunk(0, 3)]), []);
  });

  test("Unicode and CRLF map to UTF-16 offsets and omitted hunks are excluded", () => {
    const patch = "@@ -1 +1 @@\n-old\n+\u{1f680}\n@@ -3 +3 @@\n-old\n+tail";
    const targets = changedSourceTargets(parseChangedLines(patch), "\u{1f680}\r\nkeep\r\ntail");
    assert.deepEqual(targets[0].spans, [{ start: 0, end: 2 }]);
    assert.deepEqual(targets[1].spans, [{ start: 10, end: 14 }]);
    const included = includedTargets(targets, "@@ -1 +1 @@\n-old\n+\u{1f680}");
    assert.equal(included.length, 1);
    assert.deepEqual(uncoveredTargets(included, [sourceChunk(0, 2)]), []);
  });

  test("candidate count is bounded and missing source remains explicit", async () => {
    const count = CHANGED_CODE_LIMITS.maxCandidateChunksPerFile + 3;
    const source = "x".repeat(count);
    const patch = "@@ -0,0 +1 @@\n+" + source;
    const candidates = Array.from({ length: count }, (_, i) => ({ ...chunk(1, 1, "part" + i), source_spans: [{ start: i, end: i + 1 }] }));
    const result = await buildChangedCodeContext({ headSha: "head", files: [{ filename: "f.ts", status: "added", patch }] }, stubDeps({ "f.ts": source }, () => candidates));
    assert.equal(result.files[0].chunks.length, CHANGED_CODE_LIMITS.maxCandidateChunksPerFile);
    assert.equal(result.files[0].candidateLimitReached, true);
    assert.equal(result.files[0].coverage, "partial");
  });
});
