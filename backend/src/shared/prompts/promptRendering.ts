/**
 * Truncates PRESERVING structure (newlines, code formatting) — unlike
 * utils/readmeDebugLog.ts's docPreview, which collapses whitespace for a
 * single-line LOG message and would mangle code shown to the model.
 */
export function truncate(text: string, maxChars: number): string {
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`;
}

/**
 * Renders as many whole items as fit under a combined character budget,
 * always including at least the first even if it alone exceeds the cap.
 * Always keeps a PREFIX of the input array (breaks on the first non-fitting
 * item, never skips-and-continues), so citation numbering computed from the
 * original array index stays correct under truncation.
 *
 * This is how "smallest amount of highly relevant context" (not a token
 * budget service — see contextBudgetService, which is Review's differently-
 * shaped weighted-bucket allocator) is enforced per block. Shared by Q&A and
 * Interview; relocated here from interviewPromptBuilder.ts, where it was
 * originally private.
 */
export function renderCapped<T>(items: T[], render: (item: T, index: number) => string, maxChars: number): string {
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const piece = render(items[i], i);
    if (parts.length > 0 && total + piece.length > maxChars) break;
    parts.push(piece);
    total += piece.length;
  }
  return parts.join("\n\n");
}

/**
 * Common fields across RepositorySummary/ArchitectureSummary/ComponentSummary
 * — enough for a short orientation block without a per-type renderer.
 * Untruncated; Q&A caps it itself so it can record whether truncation happened.
 */
export function summaryBlockText(summary: unknown): string {
  const s = summary as any;
  if (!s) return "";
  return [
    s.purpose ? `Purpose: ${s.purpose}` : null,
    s.summary ? `Summary: ${s.summary}` : null,
    s.architectureStyle ? `Style: ${s.architectureStyle}` : null,
    s.majorComponents?.length ? `Major components: ${s.majorComponents.join(", ")}` : null,
    s.responsibilities?.length ? `Responsibilities: ${s.responsibilities.join(", ")}` : null,
    s.techStack?.length ? `Tech stack: ${s.techStack.join(", ")}` : null,
    s.technologies?.length ? `Technologies: ${s.technologies.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderSummaryBlock(summary: unknown, maxChars: number = 1000): string {
  if (!summary) return "";
  return truncate(summaryBlockText(summary), maxChars);
}
