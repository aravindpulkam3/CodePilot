/**
 * Prompt-context provenance for retrieval-backed answers.
 *
 * Two deliberately separate concepts live here:
 *
 * - PromptContextItem — AUTHORITATIVE provenance: one entry that was actually
 *   inserted into the prompt, exactly as the model saw it (heading + body).
 *   Includes non-displayable background context. Built by the same code that
 *   renders the prompt, never reconstructed afterwards, and persisted as a
 *   snapshot so an old answer keeps showing the evidence it was generated
 *   from even after the repository is re-indexed.
 * - SourceRef — the DISPLAY DTO the frontend renders. Derived from a snapshot
 *   only through toDisplaySources(), the single conversion boundary.
 *
 * Model-attributed evidence (e.g. a future review finding saying "this relies
 * on [3]") is a third concept and must stay a separate field that references
 * SourceRef.n — it is a claim by the model, not proof of what it relied on.
 */

export type ContextKind = "code" | "imports" | "documentation" | "summary";

export interface ImportRelations {
  anchor: string;
  /** Files the anchor imports. */
  dependencies: string[];
  /** Files that import the anchor. */
  dependents: string[];
}

/** Authoritative: one entry actually inserted into the prompt. Persisted. */
export interface PromptContextItem {
  /** The [n] label rendered in the prompt; null = unnumbered background that can't be cited. */
  n: number | null;
  /** Invariant: displayable ⇔ n !== null. */
  displayable: boolean;
  kind: ContextKind;
  /** Exact heading line rendered into the prompt. */
  heading: string;
  /** Exact body rendered into the prompt, without the truncation marker. */
  body: string;
  truncated: boolean;
  filePath?: string;
  symbol?: string;
  /** Needed to know whether body lines are file-aligned (class_skeleton lines are synthetic). */
  symbolType?: string;
  /** 1-based. */
  lineStart?: number;
  lineEnd?: number;
  section?: string;
  title?: string;
  summaryLevel?: "component" | "architecture" | "repository";
  imports?: ImportRelations;
  commitSha?: string;
}

export interface PromptContextSnapshot {
  version: 1;
  /** Captured once per turn so display URLs never need a later lookup. */
  repoHtmlUrl: string | null;
  items: PromptContextItem[];
}

/** Display DTO — derived only via toDisplaySources(). */
export interface SourceRef {
  /** Exactly the [n] the model saw. */
  n: number;
  kind: ContextKind;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  /** File line of the excerpt's first line; omitted when the excerpt isn't file-aligned. */
  excerptStartLine?: number;
  section?: string;
  title?: string;
  summaryLevel?: "component" | "architecture";
  imports?: ImportRelations;
  excerpt: string;
  truncated: boolean;
  commitSha?: string;
  /** GitHub blob URL pinned to commitSha; absent without a sha. */
  url?: string;
}

export type SourcesProvenance = "exact" | "legacy";

export const TRUNCATION_MARKER = "\n...[truncated]";

// The synthetic self-describing header both chunkers prepend to stored
// content (astChunking.service.ts#buildHeader, documentationChunking's
// buildChunk). Useful to the embedder, noise to a reader — and its facts are
// restated in each entry's heading.
const HEADER_LINE = /^\/\/ (File|Language|Type|Name|Exported|Class|Members|Part|Signature|Context|Section): /;

/**
 * Removes the leading synthetic header block. Only fires when line 1 is a
 * `// File:` header line, and stops at the first line that isn't one, so a
 * real `//` comment at the top of the code body is kept.
 */
export function stripChunkHeader(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  if (!lines[0].startsWith("// File: ")) return content;
  let i = 0;
  while (i < lines.length && HEADER_LINE.test(lines[i])) i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}

/**
 * Caps a body to `max` characters. With `atLine`, cuts at the last line
 * boundary so an excerpt never ends mid-line — unless that boundary would
 * throw away more than half the budget (one very long line), in which case
 * it hard-cuts.
 */
export function capBody(
  text: string,
  max: number,
  opts: { atLine?: boolean } = {},
): { body: string; truncated: boolean } {
  if (text.length <= max) return { body: text, truncated: false };
  let cut = max;
  if (opts.atLine) {
    const newline = text.lastIndexOf("\n", max);
    if (newline >= max * 0.5) cut = newline;
  }
  return { body: text.slice(0, cut).trimEnd(), truncated: true };
}

type ContextItemMeta = Omit<PromptContextItem, "n" | "displayable" | "heading" | "body" | "truncated">;

export interface ContextEntryDraft {
  meta: ContextItemMeta;
  /** Heading text after the "[n] " label. */
  heading: string;
  /** Full, uncapped body text (header already stripped). */
  text: string;
  maxChars: number;
  truncateAtLine?: boolean;
  /** Render the body inside a ``` fence (code). */
  fenced?: boolean;
}

export interface RenderedSection {
  text: string;
  items: PromptContextItem[];
  nextN: number;
}

function renderEntryText(heading: string, body: string, truncated: boolean, fenced?: boolean): string {
  const shown = truncated ? `${body}${TRUNCATION_MARKER}` : body;
  return fenced ? `${heading}\n\`\`\`\n${shown}\n\`\`\`` : `${heading}\n${shown}`;
}

/**
 * Renders a section of numbered, citable entries under a body-character
 * budget. Numbers are assigned only on inclusion, so the [n] labels in the
 * text and the returned items always correspond one-to-one.
 *
 * Unlike renderCapped there is no "always include the first item" exception:
 * each body is first capped per source, and an entry that still doesn't fit
 * the section's remaining budget is skipped — a later, smaller entry may still
 * fit. The budget counts body characters (what the model reads as evidence),
 * not heading/fence characters, so a single-entry section whose budget equals
 * its per-entry cap always fits that entry.
 */
export function renderNumberedSection(
  drafts: ContextEntryDraft[],
  bodyBudget: number,
  startN: number,
): RenderedSection {
  const parts: string[] = [];
  const items: PromptContextItem[] = [];
  let used = 0;
  let n = startN;

  for (const draft of drafts) {
    const { body, truncated } = capBody(draft.text, draft.maxChars, { atLine: draft.truncateAtLine });
    if (!body.trim()) continue;
    if (used + body.length > bodyBudget) continue;

    const heading = `[${n}] ${draft.heading}`;
    parts.push(renderEntryText(heading, body, truncated, draft.fenced));
    items.push({ ...draft.meta, n, displayable: true, heading, body, truncated });
    used += body.length;
    n++;
  }

  return { text: parts.join("\n\n"), items, nextN: n };
}

/**
 * Renders one unnumbered background entry — tracked in the snapshot, but
 * never citable and never displayed as a source.
 */
export function renderBackgroundEntry(draft: ContextEntryDraft): { text: string; item: PromptContextItem } | null {
  const { body, truncated } = capBody(draft.text, draft.maxChars, { atLine: draft.truncateAtLine });
  if (!body.trim()) return null;
  return {
    text: truncated ? `${body}${TRUNCATION_MARKER}` : body,
    item: { ...draft.meta, n: null, displayable: false, heading: draft.heading, body, truncated },
  };
}

/** GitHub blob URL pinned to a commit, with a line anchor when known. */
export function githubBlobUrl(
  htmlUrl: string | null | undefined,
  sha: string | null | undefined,
  filePath: string | null | undefined,
  lineStart?: number,
  lineEnd?: number,
): string | undefined {
  if (!htmlUrl || !sha || !filePath || !/^https?:\/\//i.test(htmlUrl)) return undefined;
  const base = htmlUrl.replace(/\/+$/, "");
  const path = filePath.split("/").map(encodeURIComponent).join("/");
  // Rendered Markdown views don't support line anchors; the plain view does.
  const plain = /\.(md|markdown|mdx)$/i.test(filePath) ? "?plain=1" : "";
  let url = `${base}/blob/${encodeURIComponent(sha)}/${path}${plain}`;
  if (lineStart) url += lineEnd && lineEnd !== lineStart ? `#L${lineStart}-L${lineEnd}` : `#L${lineStart}`;
  return url;
}

// Chunk types whose body is assembled rather than copied from one contiguous
// span: a skeleton is reconstructed signature lines, and a member group
// concatenates members while omitting the fields and comments between them. In
// both cases the stored line range spans more of the file than the text shown,
// so it cannot anchor an excerpt to real line numbers.
const ASSEMBLED_CODE_CHUNKS = new Set(["class_skeleton", "class_member_group"]);

function isFileAligned(kind: ContextKind, symbolType: string | undefined): boolean {
  return kind === "code" && !ASSEMBLED_CODE_CHUNKS.has(symbolType ?? "");
}

/** The one conversion boundary from authoritative prompt context to display sources. */
export function toDisplaySources(snapshot: PromptContextSnapshot | null | undefined): SourceRef[] {
  if (!snapshot || !Array.isArray(snapshot.items)) return [];

  return snapshot.items
    .filter((item): item is PromptContextItem & { n: number } => item.displayable && item.n !== null)
    .map((item) => {
      const ref: SourceRef = {
        n: item.n,
        kind: item.kind,
        excerpt: item.body,
        truncated: item.truncated,
      };
      if (item.filePath) ref.filePath = item.filePath;
      if (item.symbol) ref.symbol = item.symbol;
      if (item.lineStart) ref.lineStart = item.lineStart;
      if (item.lineEnd) ref.lineEnd = item.lineEnd;
      if (item.section) ref.section = item.section;
      if (item.title) ref.title = item.title;
      if (item.summaryLevel === "component" || item.summaryLevel === "architecture") {
        ref.summaryLevel = item.summaryLevel;
      }
      if (item.imports) ref.imports = item.imports;
      if (item.commitSha) ref.commitSha = item.commitSha;
      if (item.lineStart && isFileAligned(item.kind, item.symbolType)) {
        ref.excerptStartLine = item.lineStart;
      }
      if (item.kind === "code" || item.kind === "documentation") {
        const url = githubBlobUrl(snapshot.repoHtmlUrl, item.commitSha, item.filePath, item.lineStart, item.lineEnd);
        if (url) ref.url = url;
      }
      return ref;
    })
    .sort((a, b) => a.n - b.n);
}

/**
 * Pre-provenance messages stored raw retrieval objects in metadata.sources:
 * the full retrieved list (not reconciled against what the prompt budget
 * actually kept), content with its synthetic header, no commit sha. Shown as
 * legacy — `n` is display order only, and there is no pinned URL.
 */
function legacyToSourceRef(raw: any, index: number): SourceRef {
  const isDoc = raw?.sourceKind === "documentation" || raw?.symbolType === "documentation";
  const filePath = raw?.filePath ?? raw?.file_path;
  const lineStart = Number(raw?.lineStart ?? raw?.start_line) || undefined;
  const lineEnd = Number(raw?.lineEnd ?? raw?.end_line) || undefined;

  const ref: SourceRef = {
    n: index + 1,
    kind: isDoc ? "documentation" : "code",
    excerpt: stripChunkHeader(String(raw?.content ?? "")),
    truncated: false,
  };
  if (filePath) ref.filePath = String(filePath);
  if (lineStart) ref.lineStart = lineStart;
  if (lineEnd) ref.lineEnd = lineEnd;
  if (isDoc) {
    const section = raw?.sectionPath ?? raw?.symbolName;
    if (section) ref.section = String(section);
  } else {
    if (raw?.symbolName) ref.symbol = String(raw.symbolName);
    if (lineStart && !ASSEMBLED_CODE_CHUNKS.has(raw?.symbolType ?? "")) ref.excerptStartLine = lineStart;
  }
  return ref;
}

/** Normalizes any stored assistant-message metadata into display sources. */
export function normalizeMessageSources(metadata: unknown): {
  sources: SourceRef[];
  provenance: SourcesProvenance | null;
} {
  let m: any = metadata;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      m = null;
    }
  }
  if (!m || typeof m !== "object") return { sources: [], provenance: null };

  const snapshot = m.promptContext;
  if (snapshot && snapshot.version === 1 && Array.isArray(snapshot.items)) {
    return { sources: toDisplaySources(snapshot), provenance: "exact" };
  }
  if (Array.isArray(m.sources) && m.sources.length > 0) {
    return { sources: m.sources.map(legacyToSourceRef), provenance: "legacy" };
  }
  return { sources: [], provenance: null };
}
