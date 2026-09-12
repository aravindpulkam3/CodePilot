import { useState, useRef, useEffect } from "react";
import { Send, User, Bot, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { SessionSidebar } from "./SessionSidebar";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { SourcesButton } from "@/components/sources/SourcesButton";
import { SourceInspector } from "@/components/sources/SourceInspector";
import { renderWithCitations } from "@/components/sources/Citation";
import { useSourceInspector } from "@/hooks/useSourceInspector";
import type { SourceRef, SourcesProvenance } from "@/types/sourceTypes";

export interface Message {
  id?: string;
  role: string;
  content: string;
  sources?: SourceRef[];
  sourcesProvenance?: SourcesProvenance | null;
}

interface ChatInterfaceProps {
  mode: "QA" | "INTERVIEW" | "REVIEW";
  messages: Message[];
  isStreaming?: boolean;
  streamedText?: string;
  streamedSources?: SourceRef[];
  onSendMessage: (message: string) => void;
  isLoadingHistory?: boolean;

  // Sidebar properties
  showSidebar?: boolean;
  sessions?: any[];
  activeSessionId?: string | null;
  onSelectSession?: (id: string | null) => void;
  onNewSession?: () => void;

  // Empty State properties
  emptyStateMessage?: string;
  placeholder?: string;
}

const INSPECTOR_ID = "source-inspector";

// Ensure we correctly identify the user messages despite casing/role string differences
function isUserMessage(msg: Message): boolean {
  return msg?.role?.trim().toLowerCase() === "user";
}

export function ChatInterface({
  mode,
  messages,
  isStreaming = false,
  streamedText = "",
  streamedSources = [],
  onSendMessage,
  isLoadingHistory = false,
  showSidebar = false,
  sessions = [],
  activeSessionId = null,
  onSelectSession,
  onNewSession,
  emptyStateMessage = "Send a message to start.",
  placeholder = "Type your message...",
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState("");

  // Sources are a Q&A feature — Interview deliberately shows none.
  const sourcesEnabled = mode === "QA";
  const inspector = useSourceInspector();
  const { close: closeInspector } = inspector;

  // Use localized scrolling so the main page doesn't jump
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, streamedText, optimisticUserMessage]);

  // When stream finishes or history updates containing our message, clear optimistic message
  useEffect(() => {
    if (!isStreaming) {
      setOptimisticUserMessage("");
    }
  }, [isStreaming]);

  // A different conversation never inherits the previous one's inspector.
  useEffect(() => {
    closeInspector();
  }, [activeSessionId, closeInspector]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    const msg = input.trim();
    setInput("");
    setOptimisticUserMessage(msg);
    onSendMessage(msg);
    if (textareaRef.current) {
      textareaRef.current.style.height = "44px";
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
    }
  };

  // Deduplicate user message if history already caught up with our optimistic message
  const lastHistoryMessage = messages[messages.length - 1];
  const shouldShowOptimistic =
    optimisticUserMessage &&
    !(
      lastHistoryMessage &&
      isUserMessage(lastHistoryMessage) &&
      lastHistoryMessage.content === optimisticUserMessage
    );

  // We filter out actual duplicates from the history itself
  const deduplicatedMessages = messages.filter((msg, idx, self) => {
    if (idx === 0) return true;
    const prev = self[idx - 1];
    if (
      isUserMessage(msg) &&
      isUserMessage(prev) &&
      msg.content === prev.content
    ) {
      return false;
    }
    return true;
  });

  const keyedMessages = deduplicatedMessages.map((msg, idx) => ({ msg, key: msg.id ?? `idx-${idx}` }));

  // The inspector's content is always resolved from the message itself.
  const inspected = inspector.messageKey
    ? keyedMessages.find((m) => m.key === inspector.messageKey)?.msg
    : undefined;
  const inspectedSources = inspected?.sources ?? [];
  const inspectorOpen = sourcesEnabled && inspectedSources.length > 0;

  // The inspected message went away (e.g. history reloaded) — close cleanly.
  useEffect(() => {
    if (inspector.messageKey && !inspectorOpen) closeInspector();
  }, [inspector.messageKey, inspectorOpen, closeInspector]);

  useEffect(() => {
    if (!inspectorOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeInspector();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOpen, closeInspector]);

  return (
    // FIX: Replaced min-h/max-h with h-full w-full so it flexes properly
    <div className="relative flex h-full w-full overflow-hidden rounded-xl border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark shadow-sm">
      {/* Sidebar for Sessions */}
      {showSidebar && (
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onNewSession={onNewSession}
          newLabel={mode === "INTERVIEW" ? "New Interview" : "New Chat"}
        />
      )}

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* FIX: Attached scrollContainerRef here */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 bg-white dark:bg-slate-950"
        >
          {isLoadingHistory ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-light dark:text-muted-dark">
              <Loader2 className="h-5 w-5 animate-spin text-signal-500" />{" "}
              Loading conversation...
            </div>
          ) : deduplicatedMessages.length === 0 &&
            !optimisticUserMessage &&
            !isStreaming ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-light dark:text-muted-dark">
              {emptyStateMessage}
            </div>
          ) : (
            keyedMessages.map(({ msg, key }) => {
              const fromUser = isUserMessage(msg);
              const sources = sourcesEnabled && !fromUser ? msg.sources ?? [] : [];
              return (
                <div
                  key={key}
                  className={cn(
                    "flex items-start gap-3",
                    fromUser ? "justify-end" : "justify-start",
                  )}
                >
                  {!fromUser && (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:border-slate-700 text-muted-light dark:text-muted-dark shadow-sm mt-1">
                      <Bot className="h-4 w-4" />
                    </div>
                  )}
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-5 py-3.5 text-[15px] leading-relaxed shadow-sm",
                      fromUser
                        ? "bg-signal-500 text-white rounded-tr-sm"
                        : "bg-slate-50 border border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 rounded-tl-sm",
                    )}
                  >
                    {fromUser ? (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    ) : (
                      <MarkdownRenderer
                        content={msg.content}
                        tone="auto"
                        renderPlainText={
                          sources.length > 0
                            ? (text) =>
                                renderWithCitations(text, {
                                  sources,
                                  provenance: msg.sourcesProvenance,
                                  interactive: true,
                                  onActivate: (n) => inspector.openAt(key, n),
                                })
                            : undefined
                        }
                      />
                    )}

                    {sources.length > 0 && (
                      <div className="mt-2">
                        <SourcesButton
                          count={sources.length}
                          active={inspectorOpen && inspector.messageKey === key}
                          controlsId={INSPECTOR_ID}
                          onClick={() => inspector.toggle(key)}
                        />
                      </div>
                    )}
                  </div>
                  {fromUser && (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal-100 border border-signal-200 dark:bg-signal-500/20 dark:border-signal-500/30 text-signal-600 dark:text-signal-400 shadow-sm mt-1">
                      <User className="h-4 w-4" />
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Optimistic User Message */}
          {shouldShowOptimistic && (
            <div className="flex items-start justify-end gap-3 animate-in slide-in-from-bottom-2 duration-300">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-signal-500 px-5 py-3.5 text-[15px] leading-relaxed text-white shadow-sm opacity-80">
                {optimisticUserMessage}
              </div>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal-100 border border-signal-200 dark:bg-signal-500/20 dark:border-signal-500/30 text-signal-600 dark:text-signal-400 shadow-sm mt-1">
                <User className="h-4 w-4" />
              </div>
            </div>
          )}

          {/* Streaming Assistant Response — citations are styled as they
              arrive but only become clickable once the answer is saved and
              shows its Sources footer. */}
          {(isStreaming || streamedText) && (
            <div className="flex items-start justify-start gap-3 animate-in fade-in duration-300">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:border-slate-700 text-muted-light dark:text-muted-dark shadow-sm mt-1">
                <Bot className="h-4 w-4" />
              </div>
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-slate-50 border border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 px-5 py-3.5 text-[15px] leading-relaxed shadow-sm w-full">
                <MarkdownRenderer
                  content={streamedText}
                  tone="auto"
                  renderPlainText={
                    sourcesEnabled && streamedSources.length > 0
                      ? (text) =>
                          renderWithCitations(text, {
                            sources: streamedSources,
                            provenance: "exact",
                            interactive: false,
                          })
                      : undefined
                  }
                />
                {isStreaming && (
                  <span className="inline-block w-2 h-4 ml-1 bg-signal-500 animate-pulse align-middle" />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-4 bg-slate-50 dark:bg-slate-900 border-t border-border-light dark:border-border-dark shrink-0">
          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-3 max-w-4xl mx-auto"
          >
            <div className="flex-1 relative">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                placeholder={placeholder}
                className="w-full max-h-32 min-h-[44px] resize-none rounded-xl border border-border-light dark:border-border-dark bg-white dark:bg-slate-950 pl-4 pr-12 py-3 text-[15px] shadow-sm focus:border-signal-500 focus:outline-none focus:ring-1 focus:ring-signal-500 transition-all scrollbar-thin"
                disabled={isStreaming}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                rows={1}
              />
            </div>
            <button
              type="submit"
              disabled={isStreaming || !input.trim()}
              className="flex h-[44px] w-[44px] items-center justify-center rounded-xl bg-signal-500 text-white shadow-sm hover:bg-signal-600 focus:outline-none focus:ring-2 focus:ring-signal-500 focus:ring-offset-2 disabled:opacity-50 transition-all shrink-0"
            >
              <Send className="h-5 w-5" />
            </button>
          </form>
        </div>
      </div>

      {inspectorOpen && inspector.messageKey && (
        <SourceInspector
          id={INSPECTOR_ID}
          messageKey={inspector.messageKey}
          sources={inspectedSources}
          provenance={inspected?.sourcesProvenance}
          focusedN={inspector.focusedN}
          flashToken={inspector.flashToken}
          onFocus={inspector.setFocused}
          onClose={closeInspector}
        />
      )}
    </div>
  );
}
