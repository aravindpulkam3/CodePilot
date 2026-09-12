// Inline citation parsing for Q&A answers. Pure and dependency-free so it
// runs directly under `node --test` (see citations.test.ts).
//
// New answers cite unified context numbers: [1], [1, 3], [1][3]. Answers
// saved before unified numbering used [Source N] / [Doc N]; those resolve
// only for legacy messages, by position among that message's code/doc
// sources — which is how the old prompt numbered them.

export type CitationRef =
  | { type: "number"; n: number }
  | { type: "legacy"; kind: "code" | "documentation"; index: number };

export interface CitationToken {
  raw: string;
  refs: CitationRef[];
}

export type CitationSegment = string | CitationToken;

export interface CitableSource {
  n: number;
  kind: string;
}

export type CitationProvenance = "exact" | "legacy" | null | undefined;

export interface ResolvedCitation {
  /** What to show for this reference. */
  label: string;
  /** The source it points to, or null when it doesn't resolve to a real source. */
  n: number | null;
}

// Not preceded by a word character, so `items[0]` in prose isn't a citation;
// not followed by "(", so a markdown link `[1](url)` isn't either.
const CITATION_PATTERN =
  /(?<!\w)\[\s*(?:(\d{1,3}(?:\s*,\s*\d{1,3})*)|(source|doc)\s+(\d{1,3}))\s*\](?!\()/gi;

/** Splits text into plain strings and citation tokens; adjacent tokens ([1][3]) merge into one. */
export function splitCitations(text: string): CitationSegment[] {
  const segments: CitationSegment[] = [];
  let last = 0;

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const start = match.index ?? 0;
    const refs: CitationRef[] = match[1]
      ? match[1].split(",").map((part): CitationRef => ({ type: "number", n: Number(part.trim()) }))
      : [
          {
            type: "legacy",
            kind: match[2].toLowerCase() === "doc" ? "documentation" : "code",
            index: Number(match[3]),
          },
        ];

    const previous = segments[segments.length - 1];
    if (start === last && previous !== undefined && typeof previous !== "string") {
      previous.raw += match[0];
      previous.refs.push(...refs);
    } else {
      if (start > last) segments.push(text.slice(last, start));
      segments.push({ raw: match[0], refs });
    }
    last = start + match[0].length;
  }

  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

/**
 * Resolves each reference in a token against the sources that belong to the
 * same message. Numeric references resolve only for exact provenance; legacy
 * [Source k]/[Doc k] references only for legacy messages. Duplicates collapse.
 */
export function resolveCitation(
  token: CitationToken,
  sources: CitableSource[],
  provenance: CitationProvenance,
): ResolvedCitation[] {
  const ordered = [...sources].sort((a, b) => a.n - b.n);
  const seen = new Set<number>();
  const resolved: ResolvedCitation[] = [];

  for (const ref of token.refs) {
    let label: string;
    let hit: CitableSource | undefined;

    if (ref.type === "number") {
      label = String(ref.n);
      hit = provenance === "exact" ? ordered.find((s) => s.n === ref.n) : undefined;
    } else {
      label = `${ref.kind === "documentation" ? "Doc" : "Source"} ${ref.index}`;
      hit = provenance === "legacy" ? ordered.filter((s) => s.kind === ref.kind)[ref.index - 1] : undefined;
    }

    if (hit) {
      if (seen.has(hit.n)) continue;
      seen.add(hit.n);
      resolved.push({ label: String(hit.n), n: hit.n });
    } else {
      resolved.push({ label, n: null });
    }
  }

  return resolved;
}
