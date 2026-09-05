import path from "path";

/**
 * Minimum prose length worth embedding on its own.
 *
 * Below this, a query carries no real signal, and because
 * searchDocumentationChunks orders by distance and cuts at a threshold, a
 * contentless query doesn't return "nothing" — it returns whichever section
 * happens to sit nearest the origin. That is how a PR titled "fix bug" ends
 * up attached to the Installation section.
 */
const MIN_MEANINGFUL_QUERY_CHARS = 25;

/** Noise that adds no semantic content but inflates length. */
function stripPrNoise(text: string): string {
  return text
    // Markdown comments GitHub templates leave behind
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Checklist markers and headings
    .replace(/^\s*[-*]\s*\[[ xX]\]\s*/gm, " ")
    .replace(/^#{1,6}\s*/gm, " ")
    // Issue/PR refs and bare URLs
    .replace(/\b(?:closes|fixes|resolves)\s+#\d+/gi, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds the query used to retrieve README sections for a pull request.
 *
 * Returns null when there is not enough prose to justify a search — the
 * caller must then skip documentation retrieval entirely. Returning nothing
 * is strictly better than returning an arbitrary section: an irrelevant
 * <Documentation> block costs prompt budget and invites the reviewer to
 * compare the diff against documentation that has nothing to do with it.
 */
export function buildDocumentationQuery(
  title: string | null | undefined,
  description: string | null | undefined,
  changedFilePaths: string[] = [],
): string | null {
  const cleanTitle = stripPrNoise(title ?? "");
  const cleanDescription = stripPrNoise(description ?? "");

  const prose = [cleanTitle, cleanDescription].filter(Boolean).join(". ");

  if (prose.length >= MIN_MEANINGFUL_QUERY_CHARS) {
    return prose;
  }

  // Thin prose. Fall back to BASENAMES only — never full paths.
  //
  // "backend/src/services/auth.service.ts" is mostly directory structure, and
  // that structure is what drags a query toward a README's file-tree section.
  // "auth.service" is the part that actually describes the subject.
  const basenames = Array.from(
    new Set(
      changedFilePaths
        .map((p) => path.posix.basename(p.replace(/\\/g, "/")))
        .map((b) => b.replace(/\.[^.]+$/, ""))
        .filter((b) => b.length > 1),
    ),
  );

  if (basenames.length === 0) return null;

  const withBasenames = [prose, basenames.join(", ")].filter(Boolean).join(". ");

  // Still nothing meaningful (e.g. one changed file called "db") — skip.
  return withBasenames.length >= MIN_MEANINGFUL_QUERY_CHARS ? withBasenames : null;
}
