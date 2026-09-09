/**
 * TEMPORARY — verification logging for the README/documentation pipeline.
 *
 * Everything here exists to make one flow observable end to end:
 *
 *   README detected -> chunked -> embedded -> persisted
 *                   -> retrieved (Q&A / Review)
 *                   -> handed to the LLM as context
 *
 * REMOVING THIS LATER:
 *   1. Set README_DEBUG=false to silence every call site at once, or
 *   2. delete this file and the `readmeLog` / `docRetrievalLog` /
 *      `docSummaryLog` / `docPreview` call sites (grep those four names —
 *      they are used nowhere else and import only from here).
 *
 * Deliberately ON by default so verification works without extra setup.
 * Flip README_DEBUG=false in the environment once you're satisfied.
 */
const README_DEBUG = process.env.README_DEBUG !== "false";

/**
 * Truncates to a single short line. Used everywhere content is logged, so a
 * README or code chunk can never be dumped whole into the server log.
 */
export function docPreview(text: string | null | undefined, maxChars = 100): string {
  if (!text) return "(empty)";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars
    ? collapsed
    : `${collapsed.slice(0, maxChars)}… (+${collapsed.length - maxChars} chars)`;
}

/** Ingestion: detection, fetch, chunking, embedding, persistence. */
export function readmeLog(message: string, ...rest: unknown[]): void {
  if (README_DEBUG) console.log(`[README] ${message}`, ...rest);
}

/** Retrieval: what documentation came back for a Q&A or Review query. */
export function docRetrievalLog(message: string, ...rest: unknown[]): void {
  if (README_DEBUG) console.log(`[DOC-RETRIEVAL] ${message}`, ...rest);
}

/** Phase 2: whether README context reached the summarization pipeline. */
export function docSummaryLog(message: string, ...rest: unknown[]): void {
  if (README_DEBUG) console.log(`[DOC-SUMMARY] ${message}`, ...rest);
}

export const isReadmeDebugEnabled = README_DEBUG;
