// Selective Prism import (not the "load everything" build) covering the
// languages this repo's own indexer parses (backend/parsers/: TypeScript,
// TSX, JavaScript, Python, Go, C++) plus common incidental files seen in
// diffs. Imports are ordered so each language's declared dependencies are
// already registered on the shared Prism object by the time it loads.
import * as Prism from "prismjs";
import "prismjs/components/prism-markup"; // markup before css/markdown, which extend it
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike"; // base for javascript/c
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx"; // depends on markup + javascript
import "prismjs/components/prism-typescript"; // depends on javascript
import "prismjs/components/prism-tsx"; // depends on jsx + typescript
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-c"; // depends on clike
import "prismjs/components/prism-cpp"; // depends on c
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown"; // depends on markup

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  html: "markup",
  htm: "markup",
  xml: "markup",
};

export function languageForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return EXTENSION_TO_LANGUAGE[ext] || "plaintext";
}

/**
 * Highlights a single line of code in isolation (this file renders diffs
 * line-by-line with its own gutters, not Prism's line-numbers plugin).
 * Known limitation: multi-line tokens (unterminated block comments,
 * multi-line strings/template literals) won't tokenize correctly across
 * line boundaries since each line is highlighted as if it were the whole
 * file — accepted tradeoff, not fixed here.
 */
export function highlightLine(content: string, language: string): string {
  const grammar = Prism.languages[language];
  if (!grammar || language === "plaintext") {
    return escapeHtml(content);
  }
  try {
    return Prism.highlight(content, grammar, language);
  } catch {
    return escapeHtml(content);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
