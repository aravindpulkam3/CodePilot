// Hand-rolled unified-diff parser for a single file's GitHub `patch` string.
// No dependency is installed for this (see PR Review redesign plan) — this
// is deliberately small and only handles what a GitHub PR patch contains.

export type DiffLineType = "add" | "del" | "context" | "meta";

export interface DiffLine {
  type: DiffLineType;
  content: string; // line text, without the leading +/-/space marker
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string; // "@@ -12,7 +12,9 @@ ..."
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s@@/;

/**
 * Parses a raw unified diff (GitHub's `patch` field) into hunks of lines,
 * each tagged with its type and its line number(s) in the old/new file.
 * Returns [] for an empty/missing patch (binary files, oversized diffs) —
 * callers should render a placeholder, not treat this as an error.
 */
export function parseDiff(patch: string): DiffHunk[] {
  if (!patch) return [];

  const rawLines = patch.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of rawLines) {
    const headerMatch = raw.match(HUNK_HEADER_RE);
    if (headerMatch) {
      const oldStart = parseInt(headerMatch[1], 10);
      const oldLines = headerMatch[2] !== undefined ? parseInt(headerMatch[2], 10) : 1;
      const newStart = parseInt(headerMatch[3], 10);
      const newLines = headerMatch[4] !== undefined ? parseInt(headerMatch[4], 10) : 1;
      current = { header: raw, oldStart, oldLines, newStart, newLines, lines: [] };
      hunks.push(current);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (!current) continue; // content before the first hunk header — ignore

    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" — not attached to either side
      current.lines.push({ type: "meta", content: raw.slice(1).trim(), oldLine: null, newLine: null });
      continue;
    }

    if (raw.startsWith("+")) {
      current.lines.push({ type: "add", content: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ type: "del", content: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else {
      // context line — GitHub always prefixes with a space, but be lenient
      // about a raw line with no marker (can happen at patch boundaries).
      const content = raw.startsWith(" ") ? raw.slice(1) : raw;
      current.lines.push({ type: "context", content, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return hunks;
}
