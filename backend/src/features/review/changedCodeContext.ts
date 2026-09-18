/**
 * Enclosing code for a pull request's changed lines, taken from the PR HEAD.
 *
 * Why not the index: repository_embeddings holds the DEFAULT BRANCH tip,
 * while a patch's `+` line numbers are positions in the file at the PR's
 * head_sha. Any lines the PR adds or removes above a hunk shift every later
 * line, so matching `+` ranges against indexed chunks deterministically picks
 * the wrong symbol. Instead each changed file is fetched at head_sha and
 * chunked in memory with the same AST chunker the index uses, and the patch
 * text is verified against that content before anything is attached.
 *
 * I/O is injected (ChangedCodeDeps), so this module has no network or database
 * imports and every rule below is unit-testable.
 */
import type { ChunkMetadata } from "../../infrastructure/chunking/astChunking.service.js";
import { stripChunkHeader } from "../../shared/prompts/sourceRefs.js";

export const CHANGED_CODE_LIMITS = {
  /** Mirrors REVIEW_LIMITS.maxChangedFilesForExpansion. */
  maxFiles: 20,
  chunksPerFile: 4,
  /** Total enclosing-code characters across all files, in PR file order. */
  maxTotalChars: 40_000,
};

export type HunkCoverage = "guaranteed" | "partial" | `fallback:${string}`;

export interface EnclosingChunk {
  qualifiedName: string;
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  /** Chunk body with the synthetic // File: … header removed. */
  content: string;
}

export interface ChangedFileContext {
  filename: string;
  coverage: HunkCoverage;
  chunks: EnclosingChunk[];
  /** Human-readable changed runs / deletion points that no attached chunk covers. */
  unmapped: string[];
}

export interface ChangedCodeContext {
  headSha: string;
  files: ChangedFileContext[];
  /**
   * Files whose coverage is EXACTLY "guaranteed". Only these may skip the
   * default-branch changed_file retrieval; partial and fallback files keep it.
   */
  fullyHeadCoveredFiles: string[];
}

export interface ChangedFileInput {
  filename: string;
  status: string;
  patch?: string;
}

export interface ChangedCodeDeps {
  /** Content of `path` at `ref`, or null when it does not exist there. */
  fetchContent(path: string, ref: string): Promise<string | null>;
  chunkFile(path: string, content: string): Promise<ChunkMetadata[]>;
  supportsFile(path: string): boolean;
}

// ---------------------------------------------------------------- patch parsing

export interface PatchLine {
  /** 1-based line number in the PR-head file. */
  line: number;
  text: string;
}

export interface ParsedPatch {
  added: PatchLine[];
  context: PatchLine[];
  /** Merged runs of consecutive added head lines. */
  addedRuns: { start: number; end: number }[];
  /**
   * For each PURE deletion block (deleted lines with no added lines between
   * the same two context lines), the head line number immediately after the
   * deletion point. A deletion replaced by added lines is a modification and
   * is already covered by its added run.
   */
  deletionAnchors: number[];
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Walks the patch BODY rather than trusting hunk headers: a `@@ +c,d @@` range
 * also includes unchanged context lines, which would drag a neighbouring symbol
 * in as a false "enclosing" match. Hunk line counts bound each hunk, so lines
 * before the first `@@` (git's diff --git / --- / +++) and anything after a
 * hunk ends are ignored — GitHub patches and `git show` output parse the same.
 */
export function parseChangedLines(patch: string): ParsedPatch {
  const added: PatchLine[] = [];
  const context: PatchLine[] = [];
  const deletionAnchors: number[] = [];

  let oldRemaining = 0;
  let newRemaining = 0;
  let newLine = 0;

  // A change block is the run of -/+ lines between two context lines. Only a
  // block with deletions and NO additions is a pure deletion needing an anchor.
  let blockHasDeletion = false;
  let blockHasAddition = false;
  let blockStart = 0;
  const flushBlock = () => {
    if (blockHasDeletion && !blockHasAddition) deletionAnchors.push(blockStart);
    blockHasDeletion = false;
    blockHasAddition = false;
  };
  const markBlock = () => {
    if (!blockHasDeletion && !blockHasAddition) blockStart = newLine;
  };

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      flushBlock();
      oldRemaining = header[1] === undefined ? 1 : Number(header[1]);
      newLine = Number(header[2]);
      newRemaining = header[3] === undefined ? 1 : Number(header[3]);
      continue;
    }
    if (oldRemaining <= 0 && newRemaining <= 0) {
      flushBlock(); // outside any hunk
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    if (raw.startsWith("+")) {
      markBlock();
      blockHasAddition = true;
      added.push({ line: newLine, text: raw.slice(1) });
      newLine++;
      newRemaining--;
    } else if (raw.startsWith("-")) {
      markBlock();
      blockHasDeletion = true;
      oldRemaining--;
    } else {
      // Context: a leading space, or an empty line from a tool that trimmed it.
      flushBlock();
      context.push({
        line: newLine,
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
      });
      newLine++;
      oldRemaining--;
      newRemaining--;
    }
  }
  flushBlock();

  const addedRuns: { start: number; end: number }[] = [];
  for (const { line } of added) {
    const last = addedRuns[addedRuns.length - 1];
    if (last && line === last.end + 1) last.end = line;
    else addedRuns.push({ start: line, end: line });
  }
  return { added, context, addedRuns, deletionAnchors };
}

/**
 * Checks EVERY added line and every context line of the patch against the
 * fetched head content. Context lines matter too: they are the only evidence
 * that a deletion anchor's position is right. Compared after stripping one
 * trailing \r from each side.
 */
export function verifyPatchAgainstContent(
  parsed: ParsedPatch,
  content: string,
): "ok" | "line-mismatch" | "unverifiable" {
  const checked = [...parsed.added, ...parsed.context];
  if (checked.length === 0) return "unverifiable";
  const headLines = content.split("\n");
  const norm = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  for (const { line, text } of checked) {
    const headLine = headLines[line - 1];
    if (headLine === undefined || norm(headLine) !== norm(text))
      return "line-mismatch";
  }
  return "ok";
}

// ---------------------------------------------------------------- chunk selection

interface Target {
  label: string;
  /** Preferred matching chunks, computed against ALL head chunks. */
  matches: ChunkMetadata[];
}

/**
 * The chunks containing a line range. A class too large to stay one chunk gets
 * a class_skeleton row whose line range spans the whole class but whose body
 * is signatures only — it "overlaps" every method edit without containing the
 * method's code. So a specific chunk always wins, and the skeleton counts only
 * when nothing more specific contains the line (e.g. a field declaration).
 */
function preferredMatches(
  chunks: ChunkMetadata[],
  contains: (c: ChunkMetadata) => boolean,
): ChunkMetadata[] {
  const hits = chunks.filter(contains);
  const specific = hits.filter((c) => c.symbol_type !== "class_skeleton");
  return specific.length > 0 ? specific : hits;
}

function targetsFor(chunks: ChunkMetadata[], parsed: ParsedPatch): Target[] {
  return [
    ...parsed.addedRuns.map((r) => ({
      label: `added lines ${r.start}-${r.end}`,
      matches: preferredMatches(
        chunks,
        (c) => c.start_line <= r.end && c.end_line >= r.start,
      ),
    })),
    // A deletion is enclosed only by a chunk containing BOTH head lines around
    // the deletion point; a deletion that removed a whole symbol sits between
    // two symbols and matches nothing.
    ...parsed.deletionAnchors.map((a) => ({
      label: `deletion before line ${a}`,
      matches: preferredMatches(
        chunks,
        (c) => c.start_line <= a - 1 && c.end_line >= a,
      ),
    })),
  ];
}

/** Candidate chunks for a file, ordered by start_line and capped per file. */
export function selectEnclosingChunks(
  chunks: ChunkMetadata[],
  parsed: ParsedPatch,
): ChunkMetadata[] {
  const selected = new Set<ChunkMetadata>();
  for (const t of targetsFor(chunks, parsed))
    for (const m of t.matches) selected.add(m);
  return [...selected]
    .sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line)
    .slice(0, CHANGED_CODE_LIMITS.chunksPerFile);
}

/** Targets not covered by any KEPT chunk (after both caps). */
export function unmappedTargets(
  chunks: ChunkMetadata[],
  parsed: ParsedPatch,
  kept: ChunkMetadata[],
): string[] {
  const keptSet = new Set(kept);
  return targetsFor(chunks, parsed)
    .filter((t) => !t.matches.some((m) => keptSet.has(m)))
    .map((t) => t.label);
}

// ---------------------------------------------------------------- orchestration

const fallback = (filename: string, reason: string): ChangedFileContext => ({
  filename,
  coverage: `fallback:${reason}`,
  chunks: [],
  unmapped: [],
});

/**
 * Per-file coverage, computed after the revision guard, the per-file cap and
 * the total-characters cap, so it is final before retrieval runs:
 *  - guaranteed: every added run and deletion anchor mapped to a kept chunk
 *  - partial:    verified and at least one chunk kept, but something unmapped
 *  - fallback:*: nothing attached
 * Every step is isolated per file — one file's failure never affects another,
 * and never fails the review.
 */
export async function buildChangedCodeContext(
  input: { headSha: string; files: ChangedFileInput[] },
  deps: ChangedCodeDeps,
): Promise<ChangedCodeContext> {
  const files: ChangedFileContext[] = [];
  let remainingChars = CHANGED_CODE_LIMITS.maxTotalChars;
  let attempted = 0;

  for (const f of input.files) {
    if (!f.patch) {
      files.push(fallback(f.filename, "no-patch"));
      continue;
    }
    if (f.status === "removed") {
      files.push(fallback(f.filename, "removed"));
      continue;
    }
    if (!deps.supportsFile(f.filename)) {
      files.push(fallback(f.filename, "unsupported"));
      continue;
    }
    if (attempted >= CHANGED_CODE_LIMITS.maxFiles) {
      files.push(fallback(f.filename, "over-file-cap"));
      continue;
    }
    attempted++;

    const parsed = parseChangedLines(f.patch);

    let content: string | null;
    try {
      content = await deps.fetchContent(f.filename, input.headSha);
    } catch {
      files.push(fallback(f.filename, "fetch-failed"));
      continue;
    }
    if (content === null) {
      files.push(fallback(f.filename, "fetch-failed"));
      continue;
    }

    const verdict = verifyPatchAgainstContent(parsed, content);
    if (verdict !== "ok") {
      files.push(fallback(f.filename, verdict));
      continue;
    }

    let headChunks: ChunkMetadata[];
    try {
      headChunks = await deps.chunkFile(f.filename, content);
    } catch {
      files.push(fallback(f.filename, "parse-failed"));
      continue;
    }

    const candidates = selectEnclosingChunks(headChunks, parsed);
    const kept: ChunkMetadata[] = [];
    for (const c of candidates) {
      const body = stripChunkHeader(c.content);
      if (body.length > remainingChars) break;
      remainingChars -= body.length;
      kept.push(c);
    }

    if (kept.length === 0) {
      const reason =
        candidates.length > 0
          ? "over-char-cap"
          : parsed.addedRuns.length === 0
            ? "deletion-only"
            : "unmapped";
      files.push({
        ...fallback(f.filename, reason),
        unmapped: unmappedTargets(headChunks, parsed, kept),
      });
      continue;
    }

    const unmapped = unmappedTargets(headChunks, parsed, kept);
    files.push({
      filename: f.filename,
      coverage: unmapped.length === 0 ? "guaranteed" : "partial",
      unmapped,
      chunks: kept.map((c) => ({
        qualifiedName: c.qualified_name ?? c.symbol_name,
        symbolName: c.symbol_name,
        symbolType: c.symbol_type,
        startLine: c.start_line,
        endLine: c.end_line,
        content: stripChunkHeader(c.content),
      })),
    });
  }

  return {
    headSha: input.headSha,
    files,
    fullyHeadCoveredFiles: files
      .filter((x) => x.coverage === "guaranteed")
      .map((x) => x.filename),
  };
}
