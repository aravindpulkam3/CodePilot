// Pure, dependency-free logic behind the PR Review workspace: file grouping,
// finding order and stepping, discussion excerpts, and the layout rule.
// Kept import-free (type-only imports are erased) so `node --test` can run
// it directly — see reviewNavigation.test.ts.
import type { DiffHunk, DiffLine } from "./parseDiff";

export interface FileLike {
  filename: string;
  previous_filename?: string;
}

export interface FindingLike {
  id: string;
  file_path: string;
  line_number: number | null;
}

/** "src/a/b.ts" → "src/a/" ("" for a root-level file). */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

/** "src/a/b.ts" → "b.ts". */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A finding belongs to a file when its path matches the file's current
 * name, or its pre-rename name (the model may cite the old path).
 */
export function findingMatchesFile(findingPath: string, file: FileLike): boolean {
  return findingPath === file.filename || (!!file.previous_filename && findingPath === file.previous_filename);
}

export interface DirectoryGroup<T extends FileLike> {
  dir: string;
  files: T[];
}

/**
 * Groups files by their directory, keeping each group at the position of
 * its first file. GitHub returns PR files path-sorted, so this reads like a
 * flattened tree without making the user expand nested folders.
 */
export function groupFilesByDirectory<T extends FileLike>(files: T[]): DirectoryGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const dir = dirname(file.filename);
    const list = groups.get(dir);
    if (list) list.push(file);
    else groups.set(dir, [file]);
  }
  return [...groups.entries()].map(([dir, groupFiles]) => ({ dir, files: groupFiles }));
}

export interface OrderedFinding<F extends FindingLike> {
  finding: F;
  /** The changed file it belongs to, or null when its path matches none. */
  filename: string | null;
}

/**
 * Findings in reading order: file by file in the given file order, and
 * within a file the file-level ones (no line) first, then by line — the
 * same order they appear on screen, so stepping moves down the page.
 * Findings matching no file come last.
 */
export function orderFindings<F extends FindingLike>(files: FileLike[], findings: F[]): OrderedFinding<F>[] {
  const ordered: OrderedFinding<F>[] = [];
  const matched = new Set<string>();
  for (const file of files) {
    const own = findings
      .filter((f) => !matched.has(f.id) && findingMatchesFile(f.file_path, file))
      .sort((a, b) => (a.line_number ?? -1) - (b.line_number ?? -1));
    for (const finding of own) {
      matched.add(finding.id);
      ordered.push({ finding, filename: file.filename });
    }
  }
  for (const finding of findings) {
    if (!matched.has(finding.id)) ordered.push({ finding, filename: null });
  }
  return ordered;
}

/**
 * The item `delta` steps away from `currentIndex`, or null past either end
 * (deliberately no wrapping, so a step never jumps across the PR). With no current entry, a
 * forward step lands on the first item and a backward step on the last.
 */
export function stepThrough<T>(items: T[], currentIndex: number, delta: 1 | -1): T | null {
  if (items.length === 0) return null;
  if (currentIndex < 0) return delta === 1 ? items[0] : items[items.length - 1];
  const next = currentIndex + delta;
  if (next < 0 || next >= items.length) return null;
  return items[next];
}

/**
 * New-side lines (added and context) around `line` within the hunk that
 * contains it, for pinning the discussed code above a conversation.
 */
export function excerptAroundLine(hunks: DiffHunk[], line: number, radius: number): DiffLine[] {
  for (const hunk of hunks) {
    const newSide = hunk.lines.filter((l) => (l.type === "add" || l.type === "context") && l.newLine !== null);
    const index = newSide.findIndex((l) => l.newLine === line);
    if (index !== -1) {
      return newSide.slice(Math.max(0, index - radius), index + radius + 1);
    }
  }
  return [];
}

const ATTACHED_DIFF_RE = /^Here is the relevant diff from `([^`]+)`:\n\n```diff\n([\s\S]*?)\n```\n\n/;

export interface SplitMessage {
  /** File the injected diff hunk came from, when one was attached. */
  attachedFile: string | null;
  attachedDiff: string | null;
  body: string;
}

/**
 * The first message of a finding discussion carries the surrounding diff
 * hunk as a prefix (the backend has no patch to give the model). That
 * prefix is context for the model, not something the user typed, so the
 * thread shows it as a quiet "included" line instead of a raw diff dump.
 */
export function splitAttachedDiffContext(content: string): SplitMessage {
  const match = content.match(ATTACHED_DIFF_RE);
  if (!match) return { attachedFile: null, attachedDiff: null, body: content };
  return { attachedFile: match[1], attachedDiff: match[2], body: content.slice(match[0].length) };
}

/** Strips an optional surrounding ``` fence (with language tag) from model-written code. */
export function stripCodeFence(code: string): string {
  const trimmed = code.trim();
  const match = trimmed.match(/^```[\w+-]*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : trimmed;
}

export const NAVIGATOR_WIDTH = 280;
export const NAVIGATOR_STRIP_WIDTH = 40;
/** About 80 characters of 12.5px mono after the gutters. */
export const MIN_CODE_WIDTH = 720;

export interface ReviewLayout {
  navigator: "docked" | "strip";
  discussion: "docked" | "overlay" | "closed";
}

/**
 * Decides what is docked so the code column keeps at least MIN_CODE_WIDTH:
 * the navigator collapses to its strip first, and only if the code is
 * still too narrow does the discussion become an overlay. The code is
 * never squeezed to keep a panel docked.
 */
export function resolveLayout(
  workspaceWidth: number,
  options: { navigatorOpen: boolean; discussionOpen: boolean; discussionWidth: number },
): ReviewLayout {
  const { navigatorOpen, discussionOpen, discussionWidth } = options;
  const fitsWithNavigator = (extra: number) => workspaceWidth - NAVIGATOR_WIDTH - extra >= MIN_CODE_WIDTH;

  if (!discussionOpen) {
    return { navigator: navigatorOpen && fitsWithNavigator(0) ? "docked" : "strip", discussion: "closed" };
  }
  if (navigatorOpen && fitsWithNavigator(discussionWidth)) {
    return { navigator: "docked", discussion: "docked" };
  }
  const fitsWithStrip = workspaceWidth - NAVIGATOR_STRIP_WIDTH - discussionWidth >= MIN_CODE_WIDTH;
  return { navigator: "strip", discussion: fitsWithStrip ? "docked" : "overlay" };
}
