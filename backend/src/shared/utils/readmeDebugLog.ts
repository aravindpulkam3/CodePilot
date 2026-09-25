/**
 * TEMPORARY — verification logging for documentation retrieval.
 *
 * Makes observable which documentation was retrieved (Q&A / Review) and
 * handed to the LLM as context. (The ingestion-side logging is gone.)
 *
 * REMOVING THIS LATER:
 *   1. Set README_DEBUG=false to silence every call site at once, or
 *   2. delete this file and the `docRetrievalLog` / `docPreview` call sites
 *      (grep those two names — they import only from here).
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

/** Retrieval: what documentation came back for a Q&A or Review query. */
export function docRetrievalLog(message: string, ...rest: unknown[]): void {
  if (README_DEBUG) console.log(`[DOC-RETRIEVAL] ${message}`, ...rest);
}

export const isReadmeDebugEnabled = README_DEBUG;
