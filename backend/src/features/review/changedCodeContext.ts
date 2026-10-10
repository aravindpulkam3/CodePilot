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
import type { ChunkMetadata, SourceSpan } from "../../infrastructure/chunking/astChunking.service.js";
import { stripChunkHeader } from "../../shared/prompts/sourceRefs.js";

export const CHANGED_CODE_LIMITS = {
  /** Mirrors REVIEW_LIMITS.maxChangedFilesForExpansion. */
  maxFiles: 20,
  /** Resource ceilings for candidates, not prompt allocations. */
  maxCandidateChunksPerFile: 256,
  maxCandidateCharsPerFile: 512_000,
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
  sourceSpans?: SourceSpan[];
  structuralContext?: string;
  split?: boolean;
}

export interface ChangedFileContext {
  filename: string;
  coverage: HunkCoverage;
  chunks: EnclosingChunk[];
  /** Human-readable changed runs / deletion points that no attached chunk covers. */
  unmapped: string[];
  targets?: EnclosingTarget[];
  candidateLimitReached?: boolean;
}

export interface ChangedCodeContext {
  headSha: string;
  files: ChangedFileContext[];
  /**
   * Extraction-only coverage. The review service does NOT use this to suppress
   * retrieval; final prompt coverage is calculated after budget packing.
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

export interface EnclosingTarget {
  label: string;
  startLine: number;
  endLine: number;
  /** One original-source span per line; deletion anchors require one enclosing span. */
  spans: SourceSpan[];
  deletion?: boolean;
}

export function changedSourceTargets(parsed: ParsedPatch, content: string): EnclosingTarget[] {
  const lines = content.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const span = (line: number): SourceSpan => ({
    start: offsets[line - 1] ?? content.length,
    end: (offsets[line - 1] ?? content.length) + (lines[line - 1]?.replace(/\r$/, "").length ?? 0),
  });
  return [
    ...parsed.addedRuns.map((run) => ({
      label: `added lines ${run.start}-${run.end}`, startLine: run.start, endLine: run.end,
      spans: Array.from({ length: run.end - run.start + 1 }, (_, i) => span(run.start + i)),
    })),
    ...parsed.deletionAnchors.map((line) => ({
      label: `deletion before line ${line}`, startLine: line - 1, endLine: line, deletion: true,
      spans: line > 1 && line <= lines.length ? [{ start: span(line - 1).start, end: span(line).end }] : [],
    })),
  ];
}

/** Original source only: synthetic headers and broad citation ranges prove nothing. */
export function uncoveredTargets(targets: EnclosingTarget[], chunks: EnclosingChunk[]): string[] {
  const spans = chunks.flatMap((c) => c.sourceSpans ?? []).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return targets.filter((target) => {
    const available = target.deletion ? spans : merged;
    return !target.spans.length || target.spans.some((required) =>
      !available.some((s) => s.start <= required.start && s.end >= required.end));
  }).map((target) => target.label);
}

/** Only targets of supplied hunks participate in final enclosing coverage. */
export function includedTargets(targets: EnclosingTarget[], patch: string): EnclosingTarget[] {
  const parsed = parseChangedLines(patch);
  const lines = new Set(parsed.added.map((line) => line.line));
  const anchors = new Set(parsed.deletionAnchors);
  return targets.flatMap((target) => {
    if (target.deletion) return anchors.has(target.endLine) ? [target] : [];
    const result: EnclosingTarget[] = [];
    for (let line = target.startLine; line <= target.endLine; line++) {
      if (!lines.has(line)) continue;
      const last = result[result.length - 1];
      const sourceSpan = target.spans[line - target.startLine];
      if (last && last.endLine + 1 === line) {
        last.endLine = line;
        last.label = `added lines ${last.startLine}-${line}`;
        last.spans.push(sourceSpan);
      } else result.push({ label: `added lines ${line}-${line}`, startLine: line, endLine: line, spans: [sourceSpan] });
    }
    return result;
  });
}

export function chunkMatchesTargets(chunk: EnclosingChunk, targets: EnclosingTarget[]): boolean {
  if (chunk.sourceSpans?.length) return targets.some((target) => target.spans.some((required) =>
    chunk.sourceSpans!.some((span) => target.deletion
      ? span.start <= required.start && span.end >= required.end
      : span.start <= required.end && span.end >= required.start)));
  // Skeletons can still provide declarations, but never prove source coverage.
  return chunk.symbolType === "class_skeleton" && targets.some((t) =>
    chunk.startLine <= t.endLine && chunk.endLine >= t.startLine);
}

/** Candidates only; prompt packing owns final selection. Resource bounds apply below. */
export function selectEnclosingChunks(chunks: ChunkMetadata[], parsed: ParsedPatch): ChunkMetadata[] {
  return chunks.filter((c) => parsed.addedRuns.some((r) => c.start_line <= r.end && c.end_line >= r.start)
    || parsed.deletionAnchors.some((a) => c.start_line <= a - 1 && c.end_line >= a))
    .sort((a, b) => Number(a.symbol_type === "class_skeleton") - Number(b.symbol_type === "class_skeleton")
      || a.start_line - b.start_line || a.end_line - b.end_line);
}

export function unmappedTargets(
  _chunks: ChunkMetadata[], parsed: ParsedPatch, kept: ChunkMetadata[], content: string,
): string[] {
  return uncoveredTargets(changedSourceTargets(parsed, content), kept.map((chunk) => toEnclosingChunk(chunk, content)));
}

function toEnclosingChunk(c: ChunkMetadata, source: string): EnclosingChunk {
  const body = stripChunkHeader(c.content);
  const header = c.content.slice(0, c.content.length - body.length);
  return {
    qualifiedName: c.qualified_name ?? c.symbol_name, symbolName: c.symbol_name,
    symbolType: c.symbol_type, startLine: c.start_line, endLine: c.end_line,
    // Reuse the exact copied intervals. Header stripping also strips blank lines
    // and header-like source comments; those must not silently disappear here.
    content: c.source_spans?.length ? c.source_spans.map((span) => source.slice(span.start, span.end)).join("\n\n") : body,
    sourceSpans: c.source_spans ?? [],
    structuralContext: header.split("\n").filter((line) => /^\/\/ (Signature|Context): /.test(line)).join("\n"),
    split: (c.chunk_total ?? 1) > 1,
  };
}

// ---------------------------------------------------------------- orchestration

const fallback = (filename: string, reason: string): ChangedFileContext => ({
  filename,
  coverage: `fallback:${reason}`,
  chunks: [],
  unmapped: [],
});

/**
 * Extraction coverage after revision verification and candidate resource bounds.
 * Prompt packing recalculates coverage using only accepted snippets:
 *  - guaranteed: retained source spans cover every required changed target
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

    const targets = changedSourceTargets(parsed, content);
    const candidates = selectEnclosingChunks(headChunks, parsed);
    const kept: EnclosingChunk[] = [];
    let candidateChars = 0;
    let candidateLimitReached = false;
    for (const c of candidates) {
      if (kept.length >= CHANGED_CODE_LIMITS.maxCandidateChunksPerFile ||
          candidateChars + c.content.length > CHANGED_CODE_LIMITS.maxCandidateCharsPerFile) {
        candidateLimitReached = true;
        continue;
      }
      candidateChars += c.content.length;
      kept.push(toEnclosingChunk(c, content));
    }
    const unmapped = uncoveredTargets(targets, kept);
    files.push({
      filename: f.filename,
      coverage: !kept.length ? (candidateLimitReached ? "fallback:candidate-limit" : "fallback:unmapped")
        : unmapped.length ? "partial" : "guaranteed",
      unmapped, chunks: kept, targets, candidateLimitReached,
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
