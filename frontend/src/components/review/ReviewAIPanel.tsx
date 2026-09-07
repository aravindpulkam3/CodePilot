import { useEffect, useRef, useState } from "react";
import { Bot, User, Loader2, Send, X, ArrowLeft, Sparkles } from "lucide-react";
import { cn } from "@/utils/cn";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { useReviewAiPanel } from "@/hooks/useReviewAiPanel";
import { parseDiff } from "@/utils/parseDiff";
import { ChangedFile, Finding, getSeverityStyle } from "@/types/reviewTypes";

export type ReviewAiPanelScope = { type: "review" } | { type: "finding"; finding: Finding };

interface ReviewAIPanelProps {
  repositoryId: string;
  reviewId: string | null;
  scope: ReviewAiPanelScope;
  onScopeChange: (scope: ReviewAiPanelScope) => void;
  onClose: () => void;
  fileForFinding: ChangedFile | null;
}

const SUGGESTED_QUESTIONS = [
  { label: "Why is this a problem?", text: "Why is this a problem in this code?" },
  { label: "Why is your suggested approach better?", text: "Why is your suggested approach better than what is currently written?" },
  { label: "Show me an example", text: "Show me a concrete, production-ready example of how to implement the fix." },
  { label: "Is there an alternative solution?", text: "Is there an alternative solution or architecture pattern for this?" },
];

const WIDTH_STORAGE_KEY = "review-ai-panel-width";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isNaN(parsed)) return clampWidth(parsed);
  } catch {
    // ignore (private browsing, etc.)
  }
  return DEFAULT_WIDTH;
}

function clampWidth(width: number): number {
  const max = Math.min(MAX_WIDTH, typeof window !== "undefined" ? window.innerWidth * 0.5 : MAX_WIDTH);
  return Math.min(max, Math.max(MIN_WIDTH, width));
}

/** Builds the diff-hunk context injected into a finding discussion's first
 * message — this is what makes "AI has context of this finding and
 * surrounding diff" actually true (the backend provider itself does no
 * retrieval; see PR Review redesign plan). */
function buildDiffContext(file: ChangedFile | null, finding: Finding): string | null {
  if (!file || !file.patch) return null;
  const hunks = parseDiff(file.patch);
  const hunk =
    (finding.line_number !== null &&
      hunks.find((h) => h.lines.some((l) => l.newLine === finding.line_number))) ||
    hunks[0];
  if (!hunk) return null;
  const snippet = [hunk.header, ...hunk.lines.map((l) => (l.type === "add" ? "+" : l.type === "del" ? "-" : " ") + l.content)].join("\n");
  return `Here is the relevant diff from \`${file.filename}\`:\n\n\`\`\`diff\n${snippet}\n\`\`\``;
}

export function ReviewAIPanel({ repositoryId, reviewId, scope, onScopeChange, onClose, fileForFinding }: ReviewAIPanelProps) {
  const [width, setWidth] = useState(readStoredWidth);
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  const scopeId = scope.type === "review" ? reviewId : scope.finding.id;
  const { messages, isLoading, isStreaming, streamedText, sendMessage } = useReviewAiPanel(
    scope.type,
    scopeId,
    repositoryId
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamedText, isStreaming]);

  const persistWidth = (w: number) => {
    setWidth(w);
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(w));
    } catch {
      // ignore
    }
  };

  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return;
      const delta = startX - moveEvent.clientX; // dragging left grows the panel
      persistWidth(clampWidth(startWidth + delta));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onResizeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") persistWidth(clampWidth(width + 24));
    else if (e.key === "ArrowRight") persistWidth(clampWidth(width - 24));
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "44px";

    if (scope.type === "finding" && messages.length === 0) {
      const context = buildDiffContext(fileForFinding, scope.finding);
      await sendMessage(context ? `${context}\n\n${trimmed}` : trimmed);
    } else {
      await sendMessage(trimmed);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  };

  return (
    <div
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border-light dark:border-border-dark"
      style={{ width }}
    >
      {/* Resize handle — does not touch selectedFile/activeFindingId state
          in the parent, so it cannot remount or reset the diff pane. */}
      <button
        type="button"
        aria-label="Resize AI panel"
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none focus:outline-none focus-visible:bg-signal-500/40"
      />

      {/* Scope header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-light px-3 py-2.5 dark:border-border-dark">
        {scope.type === "finding" ? (
          <>
            <button
              type="button"
              onClick={() => onScopeChange({ type: "review" })}
              className="flex shrink-0 items-center text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
              title="Back to Review Q&A"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-ink-light dark:text-ink-dark">
                <span className={cn("h-1.5 w-1.5 rounded-full", getSeverityStyle(scope.finding.severity).dot)} />
                <span className="truncate">{scope.finding.title}</span>
              </div>
              <div className="truncate font-mono text-[11px] text-muted-light dark:text-muted-dark">
                {scope.finding.file_path}
                {scope.finding.line_number ? `:${scope.finding.line_number}` : ""}
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1.5 text-sm font-medium text-ink-light dark:text-ink-dark">
            <Sparkles className="h-3.5 w-3.5 text-signal-500" /> Review Q&A
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto shrink-0 rounded p-1 text-muted-light hover:bg-black/[.03] hover:text-ink-light dark:text-muted-dark dark:hover:bg-white/[.04] dark:hover:text-ink-dark"
          title="Close AI panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="thin-scrollbar flex-1 min-h-0 space-y-3 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-muted-light dark:text-muted-dark">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : messages.length === 0 && !streamedText && !isStreaming ? (
          <div className="space-y-2 py-4 text-center">
            <p className="text-xs text-muted-light dark:text-muted-dark">
              {scope.type === "finding"
                ? "Ask about why this was flagged, edge cases, or an alternative fix."
                : "Ask a question about this pull request's changes."}
            </p>
            {scope.type === "finding" && (
              <div className="space-y-1.5 pt-2 text-left">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => send(q.text)}
                    className="block w-full rounded-md border border-border-light px-2.5 py-1.5 text-left text-xs text-ink-light hover:border-signal-500/50 dark:border-border-dark dark:text-ink-dark"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {messages.map((msg, idx) => {
              const isUser = msg.role === "user";
              return (
                <div key={msg.id || idx} className={cn("flex items-start gap-2", isUser ? "justify-end" : "justify-start")}>
                  {!isUser && (
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-signal-100 text-signal-700 dark:bg-signal-500/10 dark:text-signal-300">
                      <Bot className="h-3.5 w-3.5" />
                    </div>
                  )}
                  <div
                    className={cn(
                      "max-w-[85%] rounded-lg px-3 py-2 text-xs",
                      isUser
                        ? "bg-signal-500 text-white"
                        : "bg-black/[.03] text-ink-light dark:bg-white/[.04] dark:text-ink-dark",
                    )}
                  >
                    {isUser ? (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    ) : (
                      <MarkdownRenderer content={msg.content} tone="auto" />
                    )}
                  </div>
                  {isUser && (
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-black/[.05] text-muted-light dark:bg-white/[.08] dark:text-muted-dark">
                      <User className="h-3.5 w-3.5" />
                    </div>
                  )}
                </div>
              );
            })}
            {isStreaming && (
              <div className="flex items-start justify-start gap-2">
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-signal-100 text-signal-700 dark:bg-signal-500/10 dark:text-signal-300">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="max-w-[85%] rounded-lg bg-black/[.03] px-3 py-2 text-xs text-ink-light dark:bg-white/[.04] dark:text-ink-dark">
                  {streamedText ? (
                    <MarkdownRenderer content={streamedText} tone="auto" />
                  ) : (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border-light p-2.5 dark:border-border-dark">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-end gap-2 rounded-lg border border-border-light bg-surface-light p-1.5 focus-within:border-signal-500/60 dark:border-border-dark dark:bg-surface-dark"
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder={scope.type === "finding" ? `Ask about "${scope.finding.title.slice(0, 30)}…"` : "Ask about this PR…"}
            disabled={isStreaming}
            className="min-h-[28px] max-h-40 flex-1 resize-none bg-transparent px-1.5 py-1 text-xs text-ink-light placeholder-muted-light focus:outline-none dark:text-ink-dark dark:placeholder-muted-dark"
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-signal-500 text-white disabled:opacity-40"
          >
            {isStreaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </form>
      </div>
    </div>
  );
}
