import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CornerDownRight, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { useReviewAiPanel } from "@/hooks/useReviewAiPanel";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { parseDiff } from "@/utils/parseDiff";
import { highlightLine, languageForFilename } from "@/utils/prismLang";
import { ChangedFile, Finding } from "@/types/reviewTypes";
import { basename, excerptAroundLine, splitAttachedDiffContext } from "@/utils/reviewNavigation";
import { SeverityIcon } from "./SeverityIcon";

interface FindingDiscussionProps {
  repositoryId: string;
  reviewId: string | null;
  /** The finding under discussion; null discusses the whole pull request. */
  finding: Finding | null;
  /** The changed file the finding belongs to, for the pinned excerpt and the injected diff. */
  file: ChangedFile | null;
  mode: "docked" | "overlay";
  /** Docked width; owned by the page so its layout rule sees the real width. */
  width: number;
  resizeHandleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
  onClose: () => void;
  onWholePr: () => void;
  onJumpToFinding: (finding: Finding) => void;
}

const FINDING_PROMPTS = [
  { label: "Why is this a problem here?", text: "Why is this a problem in this code?" },
  { label: "Why is the suggested fix better?", text: "Why is your suggested approach better than what is currently written?" },
  { label: "Show the fix applied to the whole function", text: "Show me a concrete, production-ready version of the fix applied to the whole function." },
  { label: "Is there another way to fix it?", text: "Is there an alternative solution or design for this?" },
];

const PR_PROMPTS = [
  { label: "What is the riskiest change in this PR?", text: "What is the riskiest change in this pull request, and why?" },
  { label: "What should I test before merging?", text: "What should I test before merging this pull request?" },
];

/** The diff hunk around the finding, sent with the first message — the backend has no patch to give the model. */
function buildDiffContext(file: ChangedFile | null, finding: Finding): string | null {
  if (!file?.patch) return null;
  const hunks = parseDiff(file.patch);
  const hunk =
    (finding.line_number !== null && hunks.find((h) => h.lines.some((l) => l.newLine === finding.line_number))) || hunks[0];
  if (!hunk) return null;
  const snippet = [hunk.header, ...hunk.lines.map((l) => (l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.content)].join("\n");
  return `Here is the relevant diff from \`${file.filename}\`:\n\n\`\`\`diff\n${snippet}\n\`\`\``;
}

function formatTime(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The conversation about one review finding (or the PR as a whole), styled
 * as a review thread rather than a chat: the subject and the code it is
 * about stay pinned at the top, entries are separated by hairlines, and
 * the model is simply "Reviewer". The parent remounts it per subject, so a
 * reply still streaming can never render under a different finding.
 */
export function FindingDiscussion({
  repositoryId,
  reviewId,
  finding,
  file,
  mode,
  width,
  resizeHandleProps,
  onClose,
  onWholePr,
  onJumpToFinding,
}: FindingDiscussionProps) {
  const scope = finding ? "finding" : "review";
  const { messages, isLoading, isStreaming, streamedText, sendMessage } = useReviewAiPanel(
    scope,
    finding ? finding.id : reviewId,
    repositoryId,
  );

  const [input, setInput] = useState("");
  const [excerptOpen, setExcerptOpen] = useState(mode === "overlay");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const excerpt = useMemo(() => {
    if (!finding || finding.line_number === null || !file?.patch) return [];
    return excerptAroundLine(parseDiff(file.patch), finding.line_number, 1);
  }, [finding, file]);
  const language = languageForFilename(file?.filename ?? "");
  const visibleExcerpt = excerptOpen ? excerpt : excerpt.filter((l) => l.newLine === finding?.line_number);

  // Follow new content only when the reader is already at the bottom, so
  // scrolling back through a long answer isn't yanked away mid-stream.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamedText, isStreaming]);

  const canSend = !!(finding || reviewId);
  const disabledReason = !canSend ? "Generate a review first, then discuss it here." : null;

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || !canSend) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "";
    nearBottomRef.current = true;
    const context = finding && messages.length === 0 ? buildDiffContext(file, finding) : null;
    await sendMessage(context ? `${context}\n\n${trimmed}` : trimmed);
  };

  const prompts = finding ? FINDING_PROMPTS : PR_PROMPTS;

  return (
    <aside
      aria-label="Discussion"
      style={mode === "docked" ? { width } : undefined}
      className={cn(
        "flex min-h-0 flex-col border-l border-rv-hair bg-rv-chrome",
        mode === "docked" ? "relative shrink-0" : "absolute inset-y-0 right-0 z-30 w-[min(100%,400px)] shadow-panel",
      )}
    >
      {mode === "docked" && (
        <button
          type="button"
          aria-label="Resize discussion"
          {...resizeHandleProps}
          className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none focus:outline-none focus-visible:bg-rv-tealbd"
        />
      )}

      <div className="shrink-0 border-b border-rv-hair pb-3 pl-4 pr-3 pt-2">
        <div className="mb-1 flex h-6 items-center justify-between text-[11px] text-rv-mute">
          <span>Discussion</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close discussion"
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-rv-hover hover:text-rv-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {finding ? (
          <>
            <div className="flex items-start gap-2 text-[13px] font-semibold leading-[18px] text-rv-ink">
              <SeverityIcon severity={finding.severity} className="mt-[3px]" />
              <span className="line-clamp-2">{finding.title}</span>
            </div>
            <div className="ml-5 mt-1 flex items-center gap-2 whitespace-nowrap text-xs text-rv-mute">
              <button
                type="button"
                onClick={() => onJumpToFinding(finding)}
                className="min-w-0 truncate font-mono text-rv-ink2 hover:text-rv-ink hover:underline"
                title="Show in the diff"
              >
                {basename(finding.file_path)}
                {finding.line_number !== null && `:${finding.line_number}`}
              </button>
              <span>·</span>
              <button type="button" onClick={onWholePr} className="shrink-0 hover:text-rv-ink">
                Whole PR
              </button>
            </div>
            {excerpt.length > 0 && (
              <div className="mt-2.5 overflow-hidden rounded border border-rv-hair bg-rv-code">
                <div className="prism-code grid grid-cols-[16px_34px_minmax(0,1fr)] py-1 font-mono text-xs leading-5 [font-variant-ligatures:none]">
                  {visibleExcerpt.map((line) => {
                    const flagged = line.newLine === finding.line_number;
                    return (
                      <div key={line.newLine} className="contents">
                        <span className={cn("relative h-5", flagged && "rv-active-line")}>
                          {flagged && <SeverityIcon severity={finding.severity} className="absolute left-[3px] top-1" />}
                        </span>
                        <span className={cn("h-5 select-none pr-2 text-right text-[11px] text-rv-lnc", flagged && "rv-active-line")}>
                          {line.newLine}
                        </span>
                        <span
                          className={cn("h-5 overflow-hidden whitespace-pre pr-2 text-rv-ink", flagged && "rv-active-line rv-active-code")}
                          dangerouslySetInnerHTML={{ __html: highlightLine(line.content || " ", language) }}
                        />
                      </div>
                    );
                  })}
                </div>
                {excerpt.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setExcerptOpen((v) => !v)}
                    className="w-full border-t border-rv-hair px-2.5 py-1 text-left text-[11px] text-rv-mute hover:text-rv-ink"
                  >
                    {excerptOpen ? "Show only the flagged line" : "Show surrounding lines"}
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-[13px] font-semibold leading-[18px] text-rv-ink">Whole pull request</div>
            <p className="mt-1 text-xs text-rv-mute">Questions about the change as a whole — the summary and every finding.</p>
          </>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="thin-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        {isLoading ? (
          <p className="px-4 py-4 text-xs text-rv-mute">Loading the conversation…</p>
        ) : messages.length === 0 && !isStreaming ? (
          <div className="px-4 py-3.5">
            <p className="mb-2 text-[13px] text-rv-ink2">
              {finding
                ? "Ask about this finding. The reviewer sees the finding and the diff around it."
                : "Ask about this pull request as a whole."}
            </p>
            {canSend &&
              prompts.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => send(p.text)}
                  className="flex h-[26px] w-full items-center gap-2 text-left text-[13px] text-rv-ink2 hover:text-rv-ink"
                >
                  <CornerDownRight className="h-3 w-3 shrink-0 text-rv-mute" />
                  {p.label}
                </button>
              ))}
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <ThreadEntry
                key={msg.id ?? i}
                author={msg.role === "user" ? "You" : "Reviewer"}
                time={formatTime(msg.created_at)}
                content={msg.content}
              />
            ))}
            {isStreaming && (
              <div className="px-4 py-3.5">
                <div className="mb-1 text-xs font-semibold text-rv-ink">Reviewer</div>
                {streamedText ? (
                  <MarkdownRenderer content={streamedText} tone="review" />
                ) : (
                  <p className="text-[13px] text-rv-mute">Thinking…</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="shrink-0 border-t border-rv-hair pb-3 pl-4 pr-3 pt-2.5"
      >
        <textarea
          ref={textareaRef}
          rows={2}
          value={input}
          disabled={!canSend || isStreaming}
          onChange={(e) => {
            setInput(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder={disabledReason ?? (messages.length === 0 && finding ? "Ask about this finding…" : "Reply…")}
          aria-label="Reply"
          className="block max-h-40 min-h-[56px] w-full resize-none rounded border border-rv-bd bg-rv-code px-2.5 py-2 text-[13px] text-rv-ink placeholder:text-rv-mute focus:border-rv-tealbd focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between text-[11px] text-rv-mute">
          <span>{isStreaming ? "Reviewer is replying…" : "Enter to send · Shift+Enter for a new line"}</span>
          <button
            type="submit"
            disabled={!input.trim() || isStreaming || !canSend}
            className="inline-flex h-7 items-center rounded border border-rv-bd px-2.5 text-xs font-medium text-rv-ink hover:bg-rv-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reply
          </button>
        </div>
      </form>
    </aside>
  );
}

function ThreadEntry({ author, time, content }: { author: string; time: string | null; content: string }) {
  const { attachedFile, attachedDiff, body } = splitAttachedDiffContext(content);
  const [showDiff, setShowDiff] = useState(false);

  return (
    <div className="border-b border-rv-hair px-4 py-3.5 last:border-b-0">
      <div className="mb-1 flex items-baseline gap-2 text-xs font-semibold text-rv-ink">
        {author}
        {time && <span className="text-[11px] font-normal text-rv-mute">{time}</span>}
      </div>
      {attachedFile && (
        <>
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            className="mb-1.5 flex items-center gap-1 text-xs text-rv-mute hover:text-rv-ink"
            aria-expanded={showDiff}
          >
            {showDiff ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Included the diff hunk from {basename(attachedFile)}
          </button>
          {showDiff && attachedDiff && (
            <pre className="thin-scrollbar mb-2 overflow-x-auto rounded border border-rv-hair bg-rv-code px-2.5 py-2 font-mono text-xs leading-[19px] text-rv-ink2">
              {attachedDiff}
            </pre>
          )}
        </>
      )}
      <MarkdownRenderer content={body} tone="review" />
    </div>
  );
}
