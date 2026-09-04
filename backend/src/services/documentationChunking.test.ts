import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { documentationChunker } from "./documentationChunking.service.js";
import { isDocumentationFile } from "../utils/documentationPaths.js";

describe("isDocumentationFile", () => {
  test("matches README at the repo root, any case/extension", () => {
    for (const p of ["README.md", "readme.md", "Readme.MD", "README", "readme.rst", "README.txt"]) {
      assert.equal(isDocumentationFile(p), true, p);
    }
  });

  test("rejects nested docs and non-README files", () => {
    for (const p of ["docs/README.md", "src/readme.md", "CONTRIBUTING.md", "index.ts", "readme.ts"]) {
      assert.equal(isDocumentationFile(p), false, p);
    }
  });
});

describe("documentationChunker.chunkDocument", () => {
  test("splits on headings and carries the breadcrumb path", async () => {
    const src = [
      "# Project",
      "Intro text.",
      "## Getting Started",
      "Some setup.",
      "### Docker",
      "Run it in docker.",
    ].join("\n");

    const chunks = await documentationChunker.chunkDocument("README.md", src);
    const names = chunks.map((c) => c.symbol_name);

    assert.deepEqual(names, ["Project", "Project > Getting Started", "Project > Getting Started > Docker"]);
    assert.ok(chunks.every((c) => c.symbol_type === "documentation"));
    assert.ok(chunks.every((c) => c.language === "Markdown"));
    assert.ok(chunks.every((c) => c.content.includes("// Section:")));
  });

  test("a '#' inside a fenced code block does not create a section", async () => {
    const src = [
      "# Setup",
      "Run this:",
      "```bash",
      "# install dependencies",
      "npm install",
      "# start the worker",
      "npm run worker",
      "```",
      "Done.",
    ].join("\n");

    const chunks = await documentationChunker.chunkDocument("README.md", src);

    assert.equal(chunks.length, 1, "fence comments must not split the section");
    assert.ok(chunks[0].content.includes("npm run worker"));
    assert.ok(chunks[0].content.includes("# install dependencies"));
  });

  test("content before the first heading becomes an (intro) section", async () => {
    const src = ["Badges and a tagline.", "", "# Install", "Steps here."].join("\n");
    const chunks = await documentationChunker.chunkDocument("README.md", src);

    assert.equal(chunks[0].symbol_name, "(intro)");
    assert.equal(chunks[1].symbol_name, "Install");
  });

  test("a table is never split internally", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| var${i} | description ${i} |`);
    const src = ["# Config", "| Name | Description |", "| --- | --- |", ...rows].join("\n");

    const chunks = await documentationChunker.chunkDocument("README.md", src);
    const withTable = chunks.filter((c) => c.content.includes("| var0 |"));

    assert.equal(withTable.length, 1);
    // Every row lands in that same chunk — the table moved as one unit.
    assert.ok(withTable[0].content.includes("| var39 |"));
  });

  test("an oversized section splits at block boundaries, repeating the breadcrumb", async () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${"filler ".repeat(30)}`);
    const src = ["# Big Section", ...paragraphs.flatMap((p) => [p, ""])].join("\n");

    const chunks = await documentationChunker.chunkDocument("README.md", src);

    assert.ok(chunks.length > 1, "should have split");
    assert.ok(chunks.every((c) => c.symbol_name.startsWith("Big Section")));
    assert.ok(chunks.every((c) => c.content.includes("// Section: Big Section")));
    assert.ok(chunks.every((c) => c.content.length <= 6000 + 200));
    // No paragraph was cut in half.
    assert.ok(chunks.every((c) => !/Paragraph \d+ (filler ){1,10}$/.test(c.content)));
  });

  test("identical repeated sections are de-duplicated by content hash", async () => {
    const src = ["## Example", "Same body.", "## Example", "Same body."].join("\n");
    const chunks = await documentationChunker.chunkDocument("README.md", src);

    const hashes = new Set(chunks.map((c) => c.content_hash));
    assert.equal(hashes.size, chunks.length, "no duplicate hashes may reach the INSERT");
    assert.equal(chunks.length, 1);
  });

  test("heading-only sections are dropped, sections with a body are kept", async () => {
    // Mirrors a real README: "Getting Started" holds no prose of its own,
    // only child sections; "Screenshots" is a bare decorative header.
    const src = [
      "# Project",
      "A tool that does things.",
      "## Screenshots",
      "## Getting Started",
      "### Prerequisites",
      "Node 22 and Docker.",
      "### Installation",
      "Run `npm install`.",
    ].join("\n");

    const chunks = await documentationChunker.chunkDocument("README.md", src);
    const names = chunks.map((c) => c.symbol_name);

    assert.deepEqual(names, [
      "Project",
      "Project > Getting Started > Prerequisites",
      "Project > Getting Started > Installation",
    ]);
    assert.ok(!names.includes("Project > Screenshots"), "bare header must be dropped");
    assert.ok(!names.includes("Project > Getting Started"), "parent with no body must be dropped");
  });

  test("a heading with only a link still counts as having a body", async () => {
    const src = ["## Live Demo", "https://example.com"].join("\n");
    const chunks = await documentationChunker.chunkDocument("README.md", src);

    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].content.includes("https://example.com"));
  });

  test("a document of nothing but headings still yields a chunk", async () => {
    // The filter must never be able to empty the result: an empty chunk list
    // makes the indexer delete every existing row for the file.
    const src = ["# A", "## B", "### C"].join("\n");
    const chunks = await documentationChunker.chunkDocument("README.md", src);

    assert.ok(chunks.length >= 1, "must fall back rather than return []");
    assert.ok(chunks[0].content.includes("# A"));
  });

  test("a heading-less document still yields at least one chunk", async () => {
    const chunks = await documentationChunker.chunkDocument("README.md", "Just one line of prose.");
    assert.ok(chunks.length >= 1, "must never return [] for non-empty input");
  });

  test("empty input yields no chunks", async () => {
    assert.deepEqual(await documentationChunker.chunkDocument("README.md", "   \n\n  "), []);
  });

  test("line numbers reference real source offsets", async () => {
    const src = ["# One", "a", "", "# Two", "b"].join("\n");
    const chunks = await documentationChunker.chunkDocument("README.md", src);

    assert.equal(chunks[0].start_line, 1);
    assert.equal(chunks[1].start_line, 4);
  });

  test("stable hashing: identical input produces identical chunk hashes", async () => {
    const src = "# A\nbody\n## B\nmore";
    const first = await documentationChunker.chunkDocument("README.md", src);
    const second = await documentationChunker.chunkDocument("README.md", src);

    assert.deepEqual(
      first.map((c) => c.content_hash),
      second.map((c) => c.content_hash),
      "unstable hashes would re-embed the whole document on every sync",
    );
  });
});
