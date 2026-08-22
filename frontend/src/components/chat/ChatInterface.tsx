import { useState, useRef, useEffect } from "react";
import { MessageSquare, Plus, Send, User, Bot, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { SourceList } from "./SourceList";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";

export interface Message {
  id?: string;
  role: string;
  content: string;
  sources?: any[];
}

interface ChatInterfaceProps {
  mode: "QA" | "INTERVIEW" | "REVIEW";
  messages: Message[];
  isStreaming?: boolean;
  streamedText?: string;
  streamedSources?: any[];
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
  const [optimisticUserMessage, setOptimisticUserMessage] = useState("");
  const [selectedSource, setSelectedSource] = useState<any>(null);
  

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    const msg = input.trim();
    setInput("");
    setOptimisticUserMessage(msg);
    onSendMessage(msg);
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

  return (
    // FIX: Replaced min-h/max-h with h-full w-full so it flexes properly
    <div className="flex h-full w-full overflow-hidden rounded-xl border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark shadow-sm">
      {/* Sidebar for Sessions */}
      {showSidebar && (
        <div className="w-64 border-r border-border-light dark:border-border-dark bg-slate-50 dark:bg-slate-900/50 flex flex-col shrink-0">
          <div className="p-4 border-b border-border-light dark:border-border-dark">
            <button
              onClick={onNewSession}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-signal-500 px-3 py-2 text-sm font-medium text-white hover:bg-signal-600 transition-colors shadow-sm"
            >
              <Plus className="h-4 w-4" /> New Chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-light dark:text-muted-dark">
                No conversations yet.
              </p>
            ) : (
              sessions.map((session: any) => (
                <button
                  key={session.id}
                  onClick={() => onSelectSession?.(session.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors truncate",
                    activeSessionId === session.id
                      ? "bg-white dark:bg-slate-800 text-ink-light dark:text-ink-dark shadow-sm ring-1 ring-border-light dark:ring-border-dark"
                      : "text-muted-light dark:text-muted-dark hover:bg-white/50 dark:hover:bg-slate-800/50",
                  )}
                >
                  <MessageSquare className="h-4 w-4 shrink-0" />
                  <span className="truncate">
                    Chat {new Date(session.created_at).toLocaleDateString()}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div
        className={cn(
          "flex-1 flex flex-col min-w-0",
          selectedSource
            ? "border-r border-border-light dark:border-border-dark"
            : "",
        )}
      >
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
            deduplicatedMessages.map((msg: any, idx: number) => {
              const fromUser = isUserMessage(msg);
              return (
                <div
                  key={msg.id ?? idx}
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
                      <MarkdownRenderer content={msg.content} />
                    )}

                    {mode !== "INTERVIEW" &&
                      msg.sources &&
                      msg.sources.length > 0 && (
                        <div className="mt-3">
                          <SourceList
                            sources={msg.sources}
                            onSourceSelect={setSelectedSource}
                            selectedSourceId={selectedSource?.id}
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

          {/* Streaming Assistant Response */}
          {(isStreaming || streamedText) && (
            <div className="flex items-start justify-start gap-3 animate-in fade-in duration-300">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 border border-slate-200 dark:bg-slate-800 dark:border-slate-700 text-muted-light dark:text-muted-dark shadow-sm mt-1">
                <Bot className="h-4 w-4" />
              </div>
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-slate-50 border border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 px-5 py-3.5 text-[15px] leading-relaxed shadow-sm w-full">
                {mode !== "INTERVIEW" &&
                  streamedSources &&
                  streamedSources.length > 0 && (
                    <div className="mb-4">
                      <SourceList
                        sources={streamedSources}
                        onSourceSelect={setSelectedSource}
                        selectedSourceId={selectedSource?.id}
                      />
                    </div>
                  )}

                <MarkdownRenderer content={streamedText} />
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
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
                style={{
                  height: "auto",
                }}
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

      {/* Right Panel for Source Code */}
      {selectedSource && (
        <div className="w-1/3 flex flex-col min-w-[320px] max-w-[500px] bg-slate-50 dark:bg-slate-900 shrink-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-light dark:border-border-dark bg-white dark:bg-slate-950">
            <h3
              className="text-sm font-semibold truncate text-slate-800 dark:text-slate-200"
              title={selectedSource.filePath || selectedSource.file_path}
            >
              {(
                selectedSource.filePath ||
                selectedSource.file_path ||
                "Unknown"
              )
                .split("/")
                .pop()}
            </h3>
            <button
              onClick={() => setSelectedSource(null)}
              className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-500 transition-colors"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <div className="mb-2 text-[10px] uppercase font-bold tracking-wider text-slate-500">
              Line{" "}
              {selectedSource.lineStart || selectedSource.start_line || "?"}
            </div>
            <pre className="text-xs font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
              {selectedSource.content || "No source content available."}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
