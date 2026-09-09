/**
 * Which repository files are treated as documentation by the indexer.
 *
 * Scope is deliberately README-only for now. Everything downstream —
 * the chunker, the `symbol_type = 'documentation'` storage, the retrieval
 * query, the prompt labelling — is document-type-agnostic, so adding
 * ARCHITECTURE.md/CONTRIBUTING.md later is a one-line addition here and
 * nothing else. What is intentionally NOT built ahead of that: per-type
 * branching, priority ordering, or a type discriminator with one real
 * member. Those only become answerable once a second type actually exists.
 */
const DOCUMENTATION_PATTERNS: RegExp[] = [
  /^readme(\.(md|markdown|rst|txt))?$/i,
];

/**
 * Root-level only. A repo with a large docs/ tree contributes nothing —
 * that bound matters because there is no ANN index on repository_embeddings
 * (pgvector's index types cap at 2000 dims; the column is VECTOR(3072)), so
 * every similarity search is a sequential scan and row count is a direct
 * latency cost.
 */
export function isDocumentationFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.includes("/")) return false;
  return DOCUMENTATION_PATTERNS.some((p) => p.test(normalized));
}
