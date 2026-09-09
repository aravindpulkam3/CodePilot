import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { astChunker } from "./astChunking.service.js";

// Mirrors astChunking.service.ts's own non-whitespace character measurement
// — used only to construct fixtures of a precise size, not to assert on.
function nonWsLength(s: string): number {
  return s.replace(/\s+/g, "").length;
}

function buildLargeClassSource(): string {
  const methodBody = (n: number) => Array.from({ length: 150 }, (_, i) => `    doWork${n}_${i}();`).join("\n");
  const methods = ["createUser", "updateUser", "deleteUser", "validateInput", "notifyAdmins"].map(
    (name, i) => `  ${name}() {\n${methodBody(i)}\n  }`,
  );
  // >6000 non-whitespace chars overall; each individual method stays well
  // under budget, so this exercises the skeleton+members split without also
  // triggering per-method AST splitting.
  return ["export class BigService extends BaseService {", ...methods, "}"].join("\n");
}

function buildLargeFunctionSource(): string {
  const statements = Array.from(
    { length: 150 },
    (_, i) => `  const result_${i} = someFunctionCall(argOne_${i}, argTwo_${i}, argThree_${i});`,
  );
  return ["export function bigFunction() {", ...statements, "  return null;", "}"].join("\n");
}

describe("astChunker.chunkFile - class handling", () => {
  test("a small class stays exactly one chunk, including all its methods", async () => {
    const src = [
      "class UserService {",
      "  constructor() {}",
      "  createUser() { return 1; }",
      "  deleteUser() { return 2; }",
      "}",
    ].join("\n");
    const chunks = await astChunker.chunkFile("user.service.ts", src);

    assert.equal(chunks.length, 1, "methods must not be separately chunked when the class is small");
    assert.equal(chunks[0].symbol_type, "class");
    assert.ok(chunks[0].content.includes("createUser"));
    assert.ok(chunks[0].content.includes("deleteUser"));
    assert.ok(!chunks.some((c) => c.symbol_type === "method"), "no separate method rows for a small class");
  });

  test("a large class becomes one class_skeleton chunk plus one chunk per method, with no duplication", async () => {
    const src = buildLargeClassSource();
    const chunks = await astChunker.chunkFile("big.service.ts", src);

    const skeleton = chunks.filter((c) => c.symbol_type === "class_skeleton");
    const methods = chunks.filter((c) => c.symbol_type === "method");

    assert.equal(skeleton.length, 1);
    assert.equal(methods.length, 5, "one chunk per method — never merged across sibling methods");
    assert.equal(chunks.length, 6, "no extra full-body class chunk alongside the skeleton");

    for (const name of ["createUser", "updateUser", "deleteUser", "validateInput", "notifyAdmins"]) {
      assert.ok(skeleton[0].content.includes(`${name}()`), `skeleton must list ${name}'s signature`);
    }
    assert.ok(!skeleton[0].content.includes("doWork0_0"), "skeleton must not include method bodies");
    assert.ok(
      methods.some((m) => m.content.includes("doWork0_0")),
      "the real body must live in the method's own chunk",
    );
    assert.ok(skeleton[0].content.includes("extends BaseService"), "inheritance is preserved in the skeleton");

    const hashes = new Set(chunks.map((c) => c.content_hash));
    assert.equal(hashes.size, chunks.length, "every chunk for this file has a distinct hash");

    assert.ok(methods.every((m) => m.parent_symbol === "BigService"));
    assert.ok(methods.every((m) => m.content.includes("// Class: BigService")));
  });
});

describe("astChunker.chunkFile - function/method size handling", () => {
  test("a small standalone function stays one whole chunk", async () => {
    const src = "function validateUser() { return true; }";
    const chunks = await astChunker.chunkFile("validate.ts", src);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].symbol_type, "function");
    assert.equal(chunks[0].chunk_index, undefined);
  });

  test("an oversized standalone function splits at statement boundaries, not blind lines", async () => {
    const src = buildLargeFunctionSource();
    const chunks = await astChunker.chunkFile("big.ts", src);

    assert.ok(chunks.length > 1, "should have split");
    assert.ok(chunks.every((c) => c.symbol_type === "function"));
    assert.ok(chunks.every((c) => /\(part \d+\/\d+\)$/.test(c.symbol_name)));
    assert.ok(
      chunks.every((c) => c.qualified_name === "bigFunction"),
      "qualified_name stays stable across parts — only symbol_name and chunk_index/chunk_total carry the split",
    );
    assert.deepEqual(
      chunks.map((c) => c.chunk_total),
      chunks.map(() => chunks.length),
      "all parts agree on chunk_total",
    );
    assert.deepEqual(
      chunks.map((c) => c.chunk_index),
      chunks.map((_, i) => i + 1),
    );

    for (const c of chunks) {
      const lines = c.content.split("\n").filter((l) => l.trim().length > 0);
      const last = lines[lines.length - 1].trim();
      assert.ok(last.endsWith(";") || last === "}", `part ends mid-statement: "${last}"`);
    }
  });

  test("a single oversized leaf statement with no further children is kept whole rather than dropped", async () => {
    const hugeExpr = `  return "${"x".repeat(7000)}";`;
    const src = ["function leaf() {", hugeExpr, "}"].join("\n");
    const chunks = await astChunker.chunkFile("leaf.ts", src);

    assert.equal(chunks.length, 1, "no children to recurse into, so it stays one oversized chunk");
    assert.equal(chunks[0].symbol_type, "function");
    assert.ok(chunks[0].content.includes("function leaf()"));
    assert.ok(chunks[0].content.includes("x".repeat(7000)));
  });
});

describe("astChunker.chunkFile - interfaces, enums, and oversized non-class symbols", () => {
  test("a small interface stays one whole chunk", async () => {
    const src = ["interface Config {", "  name: string;", "  retries: number;", "}"].join("\n");
    const chunks = await astChunker.chunkFile("config.ts", src);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].symbol_type, "interface");
  });

  test("an oversized interface falls into the generic AST-boundary split, not the class_skeleton pattern", async () => {
    const props = Array.from({ length: 600 }, (_, i) => `  prop${i}: string;`).join("\n");
    const src = `interface BigConfig {\n${props}\n}`;
    const chunks = await astChunker.chunkFile("bigconfig.ts", src);

    assert.ok(chunks.length > 1, "should have split");
    assert.ok(
      chunks.every((c) => c.symbol_type === "interface"),
      "an oversized interface must never become a class_skeleton — only classes have a signature/body duality",
    );
    assert.ok(chunks.every((c) => c.qualified_name === "BigConfig"));
  });

  test("a small enum stays one whole chunk", async () => {
    const src = ["enum Status {", "  Active,", "  Inactive,", "}"].join("\n");
    const chunks = await astChunker.chunkFile("status.ts", src);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].symbol_type, "enum");
  });
});

describe("astChunker.chunkFile - nesting and containment", () => {
  test("a small nested function inside a small outer function is not independently chunked", async () => {
    const src = ["function outer() {", "  const inner = () => { return 1; };", "  return inner();", "}"].join("\n");
    const chunks = await astChunker.chunkFile("nested.ts", src);

    assert.equal(chunks.length, 1, "the nested arrow function must not become its own top-level chunk");
    assert.equal(chunks[0].symbol_name, "outer");
  });

  test("a method contained in a whole small class does not also appear as its own top-level chunk", async () => {
    const src = ["class Small {", "  method() { return 1; }", "}"].join("\n");
    const chunks = await astChunker.chunkFile("small.ts", src);

    assert.equal(chunks.length, 1);
    assert.ok(!chunks.some((c) => c.symbol_name === "method"));
  });
});

describe("astChunker.chunkFile - decorators and exports", () => {
  test("a decorated Python function's content and start_line include the decorator", async () => {
    const src = ["@app.route('/users')", "def get_users():", "    return []"].join("\n");
    const chunks = await astChunker.chunkFile("views.py", src);

    assert.equal(chunks.length, 1);
    // Python wraps a decorated def in a decorated_definition node that
    // already includes the decorator as a child (not a preceding sibling),
    // so resolveLeadingContext's boundaryNode extension pulls the decorator
    // into `content` directly; `docstring` is reserved for genuinely
    // separate leading comment/decorator *siblings*, so it stays null here.
    assert.ok(chunks[0].content.includes("@app.route"));
    assert.equal(chunks[0].start_line, 1, "start_line should reflect the decorator's line, not the def's");
  });

  test("exported symbols get the Exported header line, non-exported ones omit it", async () => {
    const src = ["export function pub() { return 1; }", "function priv() { return 2; }"].join("\n");
    const chunks = await astChunker.chunkFile("mix.ts", src);

    const pub = chunks.find((c) => c.symbol_name === "pub")!;
    const priv = chunks.find((c) => c.symbol_name === "priv")!;

    assert.equal(pub.is_exported, true);
    assert.ok(pub.content.includes("// Exported: true"));
    assert.equal(priv.is_exported, false);
    assert.ok(!priv.content.includes("// Exported:"));
  });
});

describe("astChunker.chunkFile - malformed and symbol-free input", () => {
  test("malformed/unparseable source still yields the whole-file fallback, never an empty array", async () => {
    const src = "this is not { valid ]] typescript +++ at all ??? ";
    const chunks = await astChunker.chunkFile("broken.ts", src);

    assert.ok(chunks.length >= 1, "must fall back rather than return []");
    assert.equal(chunks[0].symbol_type, "file");
  });

  test("syntactically valid but symbol-free source also falls back to a whole-file chunk", async () => {
    const src = ["import { x } from './x';", "export const CONFIG = { a: 1, b: 2 };"].join("\n");
    const chunks = await astChunker.chunkFile("config.ts", src);

    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].symbol_type, "file");
  });

  test("empty input yields no chunks", async () => {
    assert.deepEqual(await astChunker.chunkFile("empty.ts", "   \n\n  "), []);
  });
});

describe("astChunker.chunkFile - content_hash uniqueness", () => {
  test("two symbols that hash identically are deduplicated before reaching the caller", async () => {
    const src = ["export function doThing() { return 1; }", "export function doThing() { return 1; }"].join("\n");
    const chunks = await astChunker.chunkFile("dup.ts", src);

    assert.equal(
      chunks.length,
      1,
      "identical header+content must be deduplicated, mirroring documentationChunking.service.ts's own precedent for the same UNIQUE(repository_id, file_path, content_hash) constraint",
    );
  });
});

describe("astChunker.chunkFile - size budget boundary", () => {
  function classOfSize(targetNonWs: number): string {
    const prefix = 'class Sized {\n  method() {\n    const pad = "';
    const suffix = '";\n  }\n}';
    const base = nonWsLength(prefix + suffix);
    const padLen = Math.max(0, targetNonWs - base);
    return prefix + "x".repeat(padLen) + suffix;
  }

  test("a class exactly at the budget stays one whole chunk", async () => {
    const src = classOfSize(6000);
    const chunks = await astChunker.chunkFile("sized.ts", src);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].symbol_type, "class");
  });

  test("one character over the budget triggers the class_skeleton split", async () => {
    const src = classOfSize(6001);
    const chunks = await astChunker.chunkFile("sized.ts", src);

    assert.ok(chunks.some((c) => c.symbol_type === "class_skeleton"));
  });
});

describe("astChunker.extractFileAstMetadata", () => {
  test("classes/functions inventory includes small-class methods even though chunkFile folds them into one chunk", async () => {
    const src = ["class UserService {", "  createUser() { return 1; }", "  deleteUser() { return 2; }", "}"].join(
      "\n",
    );

    const meta = await astChunker.extractFileAstMetadata("user.service.ts", src);
    assert.ok(meta);
    assert.deepEqual(meta!.classes, ["UserService"]);
    assert.deepEqual(meta!.functions, ["UserService.createUser", "UserService.deleteUser"]);

    const chunks = await astChunker.chunkFile("user.service.ts", src);
    assert.equal(chunks.length, 1, "sanity check: this is exactly the scenario the inventory must not depend on");
  });

  test("classes inventory still lists a class large enough to become a class_skeleton chunk", async () => {
    const src = buildLargeClassSource();
    const meta = await astChunker.extractFileAstMetadata("big.service.ts", src);
    assert.ok(meta);
    assert.ok(
      meta!.classes.includes("BigService"),
      "must not vanish from the Phase 2 summarization inventory just because its own chunk row is a class_skeleton, not 'class'",
    );

    const chunks = await astChunker.chunkFile("big.service.ts", src);
    assert.ok(
      !chunks.some((c) => c.symbol_type === "class"),
      "sanity check: confirms this scenario really has no symbol_type === 'class' row to derive from",
    );
  });

  test("imports are derived independently of chunking decisions", async () => {
    const src = [
      "import { Base } from './base';",
      "export class Dog extends Base {",
      "  bark() { return 'woof'; }",
      "}",
    ].join("\n");
    const meta = await astChunker.extractFileAstMetadata("dog.ts", src);

    assert.ok(meta);
    assert.deepEqual(meta!.imports, ["./base"]);
    // NOT asserting on `inheritance` here: verified separately (not via this
    // rework) that it was already broken pre-existing for TS classes —
    // class_declaration's extends clause is an unnamed `class_heritage`
    // child in this grammar, not a `superclass`/`heritage` field, so
    // visit()'s childForFieldName lookup always returns undefined for TS.
    // Unrelated to chunking, left untouched, out of scope for this rework.
  });
});
