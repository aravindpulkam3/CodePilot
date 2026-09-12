import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { astChunker, AstChunkingService } from "./astChunking.service.js";
import { Parser, Language, Query } from "web-tree-sitter";
import fs from "node:fs";

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

  test("a single huge leaf is split deterministically without exceeding the payload budget", async () => {
    const hugeExpr = `  return "${"x".repeat(7000)}";`;
    const src = ["function leaf() {", hugeExpr, "}"].join("\n");
    const chunks = await astChunker.chunkFile("leaf.ts", src);

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.content.length <= 6000));
    assert.ok(chunks.every((c) => c.content.includes("// Signature: function leaf()")));
    assert.equal(chunks.reduce((n, c) => n + (c.content.match(/x{2,}/g) ?? []).join("").length, 0), 7000);
    assert.deepEqual(chunks, await astChunker.chunkFile("leaf.ts", src));
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
  async function classOfSize(targetPayload: number): Promise<string> {
    const prefix = 'class Sized {\n  method() {\n    const pad = "';
    const suffix = '";\n  }\n}';
    const [base] = await astChunker.chunkFile("sized.ts", prefix + suffix);
    const padLen = Math.max(0, targetPayload - base.content.length);
    return prefix + "x".repeat(padLen) + suffix;
  }

  test("a class exactly at the budget stays one whole chunk", async () => {
    const src = await classOfSize(6000);
    const chunks = await astChunker.chunkFile("sized.ts", src);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].symbol_type, "class");
    assert.equal(chunks[0].content.length, 6000);
  });

  test("one character over the budget triggers the class_skeleton split", async () => {
    const src = await classOfSize(6001);
    const chunks = await astChunker.chunkFile("sized.ts", src);

    assert.ok(chunks.some((c) => c.symbol_type === "class_skeleton"));
    assert.ok(chunks.every((c) => c.content.length <= 6000));
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

const work = (label: string, count = 180) => Array.from({ length: count }, (_, i) =>
  `      ${label}(${i}, repository.currentRevision, options.force);`).join("\n");

function sourcePayload(content: string): string {
  return content.replace(/^(?:\/\/ (?:File|Language|Type|Name|Exported|Class|Part|Signature|Context):[^\n]*\n)+/, "");
}

describe("astChunker - bounded contextual chunks", () => {
  test("large class skeleton retains fields, constructor, accessors and arrow signatures", async () => {
    const src = `class Service extends Base {
      private db: Database;
      private cache: Redis;
      count = 0;
      static { initialize(); }
      helper = function(value: number): number { return value + 1; };
      constructor(db: Database) { this.db = db; }
      get size(): number { return this.count; }
      set size(value: number) { this.count = value; }
      execute = async (id: string): Promise<void> => { ${work("executeWork")} }
      run(force: boolean): void { ${work("runWork")} }
    }`;
    const chunks = await astChunker.chunkFile("service.ts", src);
    const skeleton = chunks.filter((c) => c.symbol_type === "class_skeleton").map((c) => c.content).join("\n");
    for (const declaration of ["private db: Database", "private cache: Redis", "count = 0",
      "constructor(db: Database)", "get size(): number", "set size(value: number)",
      "execute = async (id: string): Promise<void>"]) assert.ok(skeleton.includes(declaration), declaration);
    assert.ok(!skeleton.includes("executeWork") && !skeleton.includes("runWork") && !skeleton.includes("this.db = db"));
    assert.ok(!skeleton.includes("initialize()") && !skeleton.includes("return value + 1"));
    assert.ok(chunks.some((c) => c.symbol_type === "block" && c.content.includes("initialize()")));
    assert.ok(chunks.some((c) => c.qualified_name === "Service.helper" && c.content.includes("return value + 1")));
    assert.ok(chunks.some((c) => c.symbol_type === "method" && c.content.includes("executeWork(179")));
    assert.ok(chunks.every((c) => c.content.length <= 6000));
    assert.ok(chunks.filter((c) => c.qualified_name === "Service.execute").every((c) =>
      c.content.includes("// Signature: execute = async (id: string): Promise<void> =>")));
  });

  test("recursive if/else and loop parts retain the condition, branch and real signature", async () => {
    const src = `async function processRepository(repoId: string, force: boolean): Promise<Result> {
      if (repository.needsFullIndex()) {
        for (const file of files) { ${work("indexFile")} }
      } else { ${work("syncFile")} }
    }`;
    const chunks = await astChunker.chunkFile("index.ts", src);
    assert.ok(chunks.length > 2);
    for (const c of chunks) {
      assert.ok(c.content.length <= 6000);
      assert.ok(c.content.includes("// Signature: async function processRepository(repoId: string, force: boolean): Promise<Result>"));
      const payload = sourcePayload(c.content);
      if (payload.includes("indexFile(")) {
        assert.match(c.content, /\/\/ Context:.*if \(repository.needsFullIndex\(\)\).*for \(const file of files\)/);
      }
      if (payload.includes("syncFile(")) assert.match(c.content, /\/\/ Context:.*if \(repository.needsFullIndex\(\)\).*else/);
    }
    const payloads = chunks.map((c) => sourcePayload(c.content)).join("\n");
    for (let i = 0; i < 180; i++) {
      assert.equal(payloads.split(`indexFile(${i},`).length - 1, 1);
      assert.equal(payloads.split(`syncFile(${i},`).length - 1, 1);
    }
  });

  test("try/catch/finally and switch branches keep their enclosing context", async () => {
    const src = `function handle(kind: number) {
      try { ${work("tryWork")} } catch (error) { ${work("catchWork")} } finally { ${work("finallyWork")} }
      switch (kind) { case 1: ${work("caseWork")} break; default: ${work("defaultWork")} }
    }`;
    const chunks = await astChunker.chunkFile("branches.ts", src);
    for (const [label, pattern] of [
      ["tryWork", /Context:.*try/], ["catchWork", /Context:.*try.*catch \(error\)/],
      ["finallyWork", /Context:.*finally/], ["caseWork", /Context:.*switch \(kind\).*case 1:/],
      ["defaultWork", /Context:.*switch \(kind\).*default:/],
    ] as const) {
      const relevant = chunks.filter((c) => sourcePayload(c.content).includes(`${label}(`));
      assert.ok(relevant.length > 1, label);
      assert.ok(relevant.every((c) => pattern.test(c.content)), label);
    }
    assert.ok(chunks.every((c) => c.content.length <= 6000));
  });

  test("nested functions and do/while loops retain their own semantic prefixes", async () => {
    const src = `function outer() { function inner(count: number): void {
      do { ${work("nestedWork")} } while (remaining > 0);
    } }`;
    const chunks = await astChunker.chunkFile("nested-large.ts", src);
    const bodyChunks = chunks.filter((c) => sourcePayload(c.content).includes("nestedWork("));
    assert.ok(bodyChunks.length > 1);
    assert.ok(bodyChunks.every((c) => /Context:.*function inner\(count: number\): void.*do while \(remaining > 0\)/.test(c.content)));
  });

  test("whitespace, huge comments, Unicode leaves, long paths and skeletons all count toward the budget", async () => {
    const cases = [
      ["spaces.ts", `function spaces() {\n${" ".repeat(12000)}return 1;\n}`],
      ["unicode.ts", `/**${"docs ".repeat(2200)}*/\nfunction unicode() { return "${"😀".repeat(7000)}"; }`],
      [`${"long/".repeat(1000)}path.ts`, `function longPath() { ${work("pathWork")} }`],
      ["fields.ts", `class Many {\n${Array.from({ length: 650 }, (_, i) => `field${i}: string;`).join("\n")}\nrun() { return 1; } }`],
    ];
    for (const [file, src] of cases) {
      const chunks = await astChunker.chunkFile(file, src);
      assert.ok(chunks.length > 1);
      assert.ok(chunks.every((c) => c.content.length <= 6000 &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c.content)));
      assert.ok(chunks.every((c) => c.start_line >= 1 && c.end_line >= c.start_line && c.end_line <= src.split("\n").length));
    }
  });

  test("large symbol-free files preserve every top-level statement within budget", async () => {
    const src = Array.from({ length: 400 }, (_, i) => `configure(${i}, options.defaultConfiguration);`).join("\n");
    const chunks = await astChunker.chunkFile("config.ts", src);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.symbol_type === "file" && c.content.length <= 6000));
    assert.equal(chunks.map((c) => sourcePayload(c.content).trim()).join("\n"), src);
  });
});

describe("astChunker - failure atomicity", () => {
  test("unsupported and empty files skip parser initialization", async (t) => {
    const service = new AstChunkingService();
    t.mock.method(service, "init", async () => { throw new Error("must not initialize"); });
    assert.deepEqual(await service.chunkFile("unknown.txt", "content"), []);
    assert.deepEqual(await service.chunkFile("empty.ts", " \n"), []);
  });

  test("missing or corrupt WASM rejects a supported nonempty file", async (t) => {
    const missing = new AstChunkingService();
    await missing.init();
    const exists = t.mock.method(fs, "existsSync", () => false);
    await assert.rejects(missing.chunkFile("missing.ts", "function f() {}"), /AST chunking failed/);
    exists.mock.restore();
    const corrupt = new AstChunkingService();
    await corrupt.init();
    t.mock.method(Language, "load", async () => { throw new Error("corrupt WASM"); });
    await assert.rejects(corrupt.chunkFile("corrupt.ts", "function f() {}"), /AST chunking failed/);
  });

  test("null parse, query construction, and query execution failures reject", async (t) => {
    await astChunker.init();
    const parse = t.mock.method(Parser.prototype, "parse", () => null);
    await assert.rejects(astChunker.chunkFile("parse.ts", "function f() {}"), /AST chunking failed/);
    parse.mock.restore();
    // A valid but mismatched grammar parses, then rejects the TS capture query.
    const service = new AstChunkingService();
    const python = await Language.load("parsers/tree-sitter-python.wasm");
    t.mock.method(service as any, "getLanguage", async () => python);
    await assert.rejects(service.chunkFile("query.ts", "function f() {}"), /AST chunking failed/);
    t.mock.method(Query.prototype, "matches", () => { throw new Error("query execution"); });
    await assert.rejects(astChunker.chunkFile("matches.ts", "function f() {}"), /AST chunking failed/);
  });

  test("one symbol failure rejects the entire file even after another symbol succeeded", async (t) => {
    const service = new AstChunkingService();
    const internals = service as any;
    const original = internals.processNode.bind(service);
    let processed = 0;
    t.mock.method(internals, "processNode", (...args: any[]) => {
      if (++processed === 2) throw new Error("second symbol failed");
      return original(...args);
    });
    await assert.rejects(service.chunkFile("partial.ts", "function good() {}\nfunction bad() {}"), /AST chunking failed/);
    assert.equal(processed, 2);
  });
});

describe("astChunker - installed grammar naming", () => {
  for (const [ext, src, names] of [
    ["ts", "const arrow = (x: number): number => x; function plain() {}", ["arrow", "plain"]],
    ["tsx", "const Component = () => <div />;", ["Component"]],
    ["js", "const expression = function () {}; function plain() {}", ["expression", "plain"]],
    ["jsx", "const Component = () => <div />;", ["Component"]],
    ["py", "class Service:\n    def run(self):\n        return 1\ndef plain():\n    return 2", ["Service.run", "plain"]],
    ["cpp", "int freeFn(int n) { return n; } int * ns::Thing::make() { return nullptr; } struct Thing { Thing() {} ~Thing() {} int method() { return 1; } int operator+(int n) { return n; } operator bool() const { return true; } };", ["freeFn", "ns::Thing::make", "Thing.Thing", "Thing.~Thing", "Thing.method", "Thing.operator+", "Thing.operator bool"]],
    ["go", "package p\ntype (Person struct { Name string }; Count int)\ntype Alias = Person\nfunc plain() {}\nfunc (p *Person) NameOf() string { return p.Name }", ["plain", "Person.NameOf"]],
  ] as const) {
    test(`${ext} names come from the grammar's declarations`, async () => {
      const metadata = await astChunker.extractFileAstMetadata(`names.${ext}`, src);
      assert.ok(metadata);
      assert.deepEqual(metadata.functions, [...names]);
      if (ext === "go") {
        assert.deepEqual(metadata.classes, ["Person", "Count", "Alias"]);
        const chunks = await astChunker.chunkFile("names.go", src);
        assert.equal(chunks.find((c) => c.symbol_name === "NameOf")?.parent_symbol, "Person");
      }
      const chunks = await astChunker.chunkFile(`names.${ext}`, src);
      assert.ok(chunks.every((c) => c.symbol_name !== "anonymous"));
    });
  }

  test("AST inventory never calls chunkFile, including split methods", async (t) => {
    const service = new AstChunkingService();
    t.mock.method(service, "chunkFile", async () => { throw new Error("inventory must not depend on layout"); });
    const meta = await service.extractFileAstMetadata("inventory.ts", buildLargeClassSource());
    assert.deepEqual(meta?.classes, ["BigService"]);
    assert.equal(meta?.functions.length, 5);
  });
});
