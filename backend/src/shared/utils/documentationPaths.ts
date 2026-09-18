/**
 * Which non-code repository files the indexer stores, and how they are chunked.
 *
 * Two deliberately small, fixed allowlists — never "every markdown/config
 * file". There is no ANN index on repository_embeddings (pgvector's index
 * types cap at 2000 dims; the column is VECTOR(3072)), so every similarity
 * search is a sequential scan and row count is a direct latency cost.
 *
 * Both kinds are stored as symbol_type = 'documentation', so retrieval treats
 * them identically. They differ only in how they are CHUNKED:
 *  - prose docs  → documentationChunker.chunkDocument (split by headings)
 *  - config files → documentationChunker.chunkWholeFile (one byte-exact row
 *    when it fits). Markdown sectioning is wrong for JSON/YAML: it drops blank
 *    lines, and a YAML "# comment" indented 0-3 spaces parses as a heading and
 *    splits the file. Byte-exact rows are also what lets repositoryProfileFacts
 *    parse package.json / docker-compose deterministically at query time.
 */

const PROSE_DOC_BASENAMES: RegExp[] = [
  /^readme(\.(md|markdown|rst|txt))?$/i,
  /^architecture(\.(md|markdown|rst|txt))?$/i,
  /^contributing(\.(md|markdown|rst|txt))?$/i,
];

const CONFIG_BASENAMES: RegExp[] = [
  /^package\.json$/i,
  /^docker-compose([.-][\w.-]+)?\.ya?ml$/i,
  /^dockerfile([.-][\w.-]+)?$/i,
  /^\.env\.example$/i,
  /^tsconfig([.-][\w.-]+)?\.json$/i,
  /\.sql$/i,
];

/** Applies to both allowlists: generated, vendored or binary content is never indexed. */
function isDenied(normalized: string, basename: string): boolean {
  if (/(^|\/)(node_modules|dist)\//.test(normalized)) return true;
  return (
    /^package-lock\.json$/i.test(basename) ||
    /\.lock$/i.test(basename) ||
    /\.wasm$/i.test(basename)
  );
}

function normalize(filePath: string): { normalized: string; basename: string } {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return {
    normalized,
    basename: normalized.slice(normalized.lastIndexOf("/") + 1),
  };
}

/** Prose documentation (README / ARCHITECTURE / CONTRIBUTING), at any depth. */
export function isDocumentationFile(filePath: string): boolean {
  const { normalized, basename } = normalize(filePath);
  if (isDenied(normalized, basename)) return false;
  return PROSE_DOC_BASENAMES.some((p) => p.test(basename));
}

/**
 * Structured setup/runtime files that answer "how do I run this", "which
 * services", "which env vars", "which dependencies", at any depth.
 */
export function isConfigFile(filePath: string): boolean {
  const { normalized, basename } = normalize(filePath);
  if (isDenied(normalized, basename)) return false;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized)) return true;
  return CONFIG_BASENAMES.some((p) => p.test(basename));
}
