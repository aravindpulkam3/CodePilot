/**
 * Syncs the tree-sitter grammar .wasm files in backend/parsers/ from the
 * @vscode/tree-sitter-wasm package.
 *
 * WHY THIS EXISTS
 * ---------------
 * The .wasm grammars are committed binaries, and where they came from used to
 * be undocumented. That went wrong: they had been collected from two
 * different sources, and four of the five were built by an emscripten old
 * enough to emit the LEGACY "dylink" custom section. web-tree-sitter 0.26.x
 * requires "dylink.0" and rejects anything else:
 *
 *     failIf(name2 !== "dylink.0");        // web-tree-sitter.js — no message
 *
 * That throw carries no message, so it surfaced only as a bare
 * "[AST Chunker] Corrupted WASM file at ... Error", and because getLanguage()
 * catches and returns null, chunkFile() then returned [] — which the indexer
 * treats as "this file has no chunks" and DELETES every existing row for it.
 * Net effect: TypeScript/Python/Go/C++ repositories indexed to nothing, with
 * no error surfaced anywhere except this log line.
 *
 * Run `npm run parsers:sync` to restore/update them, and re-run
 * `npm run parsers:verify` to confirm they actually load.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
const source = path.join(backendRoot, "node_modules", "@vscode", "tree-sitter-wasm", "wasm");
const target = path.join(backendRoot, "parsers");

// Only the grammars LANGUAGE_REGISTRY actually references
// (see src/services/astChunking.service.ts).
const GRAMMARS = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-cpp.wasm",
];

if (!fs.existsSync(source)) {
  console.error(`Source not found: ${source}\nRun: npm install --save-dev @vscode/tree-sitter-wasm`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });

let copied = 0;
for (const name of GRAMMARS) {
  const from = path.join(source, name);
  if (!fs.existsSync(from)) {
    console.error(`  MISSING in package: ${name}`);
    continue;
  }

  // Guard against ever reintroducing a legacy-dylink grammar: the section
  // name must appear in the first bytes, right after the 8-byte wasm header.
  const head = fs.readFileSync(from).subarray(0, 32).toString("latin1");
  if (!head.includes("dylink.0")) {
    console.error(`  REJECTED ${name}: no "dylink.0" section (legacy build — web-tree-sitter 0.26+ cannot load it)`);
    continue;
  }

  fs.copyFileSync(from, path.join(target, name));
  console.log(`  copied ${name} (${fs.statSync(from).size} bytes)`);
  copied++;
}

console.log(`\n${copied}/${GRAMMARS.length} grammar(s) synced into ${target}`);
process.exit(copied === GRAMMARS.length ? 0 : 1);
