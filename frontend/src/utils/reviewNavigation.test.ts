import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  basename,
  dirname,
  excerptAroundLine,
  groupFilesByDirectory,
  orderFindings,
  resolveLayout,
  splitAttachedDiffContext,
  stepThrough,
  stripCodeFence,
} from "./reviewNavigation.ts";
import { parseDiff } from "./parseDiff.ts";

const finding = (id: string, file_path: string, line_number: number | null) => ({ id, file_path, line_number });

describe("paths", () => {
  test("dirname keeps the trailing slash and is empty at the root", () => {
    assert.equal(dirname("backend/src/a.ts"), "backend/src/");
    assert.equal(dirname("README.md"), "");
  });
  test("basename", () => {
    assert.equal(basename("backend/src/a.ts"), "a.ts");
    assert.equal(basename("a.ts"), "a.ts");
  });
});

describe("groupFilesByDirectory", () => {
  test("groups by directory in first-appearance order", () => {
    const groups = groupFilesByDirectory([
      { filename: "a/x.ts" },
      { filename: "a/y.ts" },
      { filename: "b/z.ts" },
      { filename: "root.md" },
    ]);
    assert.deepEqual(
      groups.map((g) => [g.dir, g.files.map((f) => f.filename)]),
      [
        ["a/", ["a/x.ts", "a/y.ts"]],
        ["b/", ["b/z.ts"]],
        ["", ["root.md"]],
      ],
    );
  });
});

describe("orderFindings", () => {
  const files = [{ filename: "a.ts" }, { filename: "b.ts", previous_filename: "old-b.ts" }];

  test("follows file order, file-level first, then by line; unmatched last", () => {
    const ordered = orderFindings(files, [
      finding("b-20", "b.ts", 20),
      finding("ghost", "missing.ts", 3),
      finding("a-40", "a.ts", 40),
      finding("a-file", "a.ts", null),
      finding("a-5", "a.ts", 5),
    ]);
    assert.deepEqual(
      ordered.map((o) => [o.finding.id, o.filename]),
      [
        ["a-file", "a.ts"],
        ["a-5", "a.ts"],
        ["a-40", "a.ts"],
        ["b-20", "b.ts"],
        ["ghost", null],
      ],
    );
  });

  test("a finding cited by the pre-rename path belongs to the renamed file", () => {
    const ordered = orderFindings(files, [finding("r", "old-b.ts", 1)]);
    assert.equal(ordered[0].filename, "b.ts");
  });
});

describe("stepThrough", () => {
  const items = ["a", "b", "c"];
  test("steps forward and back without wrapping", () => {
    assert.equal(stepThrough(items, 0, 1), "b");
    assert.equal(stepThrough(items, 2, 1), null);
    assert.equal(stepThrough(items, 0, -1), null);
  });
  test("with no current item, forward starts at the first and back at the last", () => {
    assert.equal(stepThrough(items, -1, 1), "a");
    assert.equal(stepThrough(items, -1, -1), "c");
  });
  test("empty list", () => {
    assert.equal(stepThrough([], -1, 1), null);
  });
});

describe("excerptAroundLine", () => {
  const hunks = parseDiff(["@@ -1,4 +1,5 @@", " one", "-two", "+TWO", "+extra", " three", " four"].join("\n"));

  test("returns new-side lines around the target, skipping deletions", () => {
    const lines = excerptAroundLine(hunks, 3, 1);
    assert.deepEqual(
      lines.map((l) => [l.newLine, l.content]),
      [
        [2, "TWO"],
        [3, "extra"],
        [4, "three"],
      ],
    );
  });
  test("clamps at the hunk edges", () => {
    assert.deepEqual(
      excerptAroundLine(hunks, 1, 1).map((l) => l.newLine),
      [1, 2],
    );
  });
  test("is empty when the line is not in the diff", () => {
    assert.deepEqual(excerptAroundLine(hunks, 99, 1), []);
  });
});

describe("splitAttachedDiffContext", () => {
  test("separates the injected hunk from what the user typed", () => {
    const content = "Here is the relevant diff from `src/a.ts`:\n\n```diff\n@@ -1 +1 @@\n-a\n+b\n```\n\nWhy is this a problem?";
    assert.deepEqual(splitAttachedDiffContext(content), {
      attachedFile: "src/a.ts",
      attachedDiff: "@@ -1 +1 @@\n-a\n+b",
      body: "Why is this a problem?",
    });
  });
  test("leaves ordinary messages untouched", () => {
    assert.deepEqual(splitAttachedDiffContext("Just a question"), {
      attachedFile: null,
      attachedDiff: null,
      body: "Just a question",
    });
  });
});

describe("stripCodeFence", () => {
  test("removes a fenced wrapper with a language tag", () => {
    assert.equal(stripCodeFence("```ts\nconst a = 1;\n```"), "const a = 1;");
  });
  test("keeps bare code", () => {
    assert.equal(stripCodeFence("  const a = 1;\n"), "const a = 1;");
  });
});

describe("resolveLayout", () => {
  const layout = (width: number, discussionOpen: boolean, navigatorOpen = true) =>
    resolveLayout(width, { navigatorOpen, discussionOpen, discussionWidth: 360 });

  test("docks everything when the code keeps 720px (1920 screen)", () => {
    assert.deepEqual(layout(1680, true), { navigator: "docked", discussion: "docked" });
  });
  test("collapses the navigator before squeezing the code (1440 and 1366 laptops)", () => {
    assert.deepEqual(layout(1200, true), { navigator: "strip", discussion: "docked" });
    assert.deepEqual(layout(1126, true), { navigator: "strip", discussion: "docked" });
    assert.deepEqual(layout(1200, false), { navigator: "docked", discussion: "closed" });
  });
  test("overlays the discussion when even the strip leaves too little code", () => {
    assert.deepEqual(layout(1000, true), { navigator: "strip", discussion: "overlay" });
  });
  test("respects a navigator the user collapsed", () => {
    assert.deepEqual(layout(1680, false, false), { navigator: "strip", discussion: "closed" });
  });
  test("narrow workspace collapses the navigator even with no discussion", () => {
    assert.deepEqual(layout(900, false), { navigator: "strip", discussion: "closed" });
  });
});
