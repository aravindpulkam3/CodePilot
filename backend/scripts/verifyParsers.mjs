/**
 * Loads every tree-sitter grammar the AST chunker depends on and runs a real
 * parse + query against each.
 *
 * This exists because a broken grammar fails SILENTLY in normal operation:
 * getLanguage() catches the load error and returns null, chunkFile() returns
 * [], and the indexer reads an empty chunk list as "this file has no symbols"
 * — deleting the file's existing rows. A repository can therefore index to
 * nothing while every job reports success. Run this after changing
 * web-tree-sitter or the parser binaries.
 *
 *   npm run parsers:verify
 */
import { Parser, Language, Query } from "web-tree-sitter";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const parsersDir = path.resolve(here, "..", "parsers");

const CASES = [
  {
    name: "typescript", file: "tree-sitter-typescript.wasm",
    src: `export class UserService {\n  async createUser(n: string) { return n; }\n}\nexport function helper(): void {}\n`,
    query: `(function_declaration) @function\n(method_definition) @method\n(class_declaration) @class`,
    minMatches: 3,
  },
  {
    name: "tsx", file: "tree-sitter-tsx.wasm",
    src: `export function App() { return <div className="x">hi</div>; }\n`,
    query: `(function_declaration) @function`,
    minMatches: 1,
  },
  {
    name: "javascript", file: "tree-sitter-javascript.wasm",
    src: `export class A { m() {} }\nfunction f() {}\n`,
    query: `(function_declaration) @function\n(method_definition) @method\n(class_declaration) @class`,
    minMatches: 3,
  },
  {
    name: "python", file: "tree-sitter-python.wasm",
    src: `class Foo:\n    def bar(self):\n        return 1\n\ndef baz():\n    pass\n`,
    query: `(function_definition) @function\n(class_definition) @class`,
    minMatches: 3,
  },
  {
    name: "go", file: "tree-sitter-go.wasm",
    src: `package main\nfunc main() {}\ntype T struct{ A int }\nfunc (t T) M() {}\n`,
    query: `(function_declaration) @function\n(method_declaration) @method\n(type_declaration) @class`,
    minMatches: 3,
  },
  {
    name: "cpp", file: "tree-sitter-cpp.wasm",
    src: `class C { public: void m() {} };\nint main() { return 0; }\nstruct S { int a; };\n`,
    query: `(function_definition) @function\n(class_specifier) @class\n(struct_specifier) @struct`,
    minMatches: 3,
  },
];

await Parser.init();

let ok = 0;
const failures = [];

for (const c of CASES) {
  const wasmPath = path.join(parsersDir, c.file);
  try {
    if (!fs.existsSync(wasmPath)) throw new Error("file missing — run `npm run parsers:sync`");

    const head = fs.readFileSync(wasmPath).subarray(0, 32).toString("latin1");
    if (!head.includes("dylink.0")) {
      throw new Error('legacy "dylink" section — web-tree-sitter 0.26+ requires "dylink.0"');
    }

    const lang = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(lang);

    const tree = parser.parse(c.src);
    if (!tree) throw new Error("parse() returned null");

    const matches = new Query(lang, c.query).matches(tree.rootNode);
    if (matches.length < c.minMatches) {
      throw new Error(`query matched ${matches.length}, expected >= ${c.minMatches} (grammar/query drift?)`);
    }

    console.log(`  OK    ${c.name.padEnd(11)} abi=${lang.abiVersion ?? "?"} matches=${matches.length}`);
    ok++;
  } catch (e) {
    console.log(`  FAIL  ${c.name.padEnd(11)} ${e.message || e}`);
    failures.push(c.name);
  }
}

console.log(`\n${ok}/${CASES.length} grammars OK`);
if (failures.length > 0) {
  console.error(
    `\nBROKEN: ${failures.join(", ")}\n` +
      `Files in these languages will produce ZERO chunks, and the indexer will\n` +
      `delete any rows they already had. Fix before indexing.`,
  );
  process.exit(1);
}
