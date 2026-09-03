import React, { useState, useRef, useEffect } from "react";
import {
  X,
  Sparkles,
  Send,
  Loader2,
  Trash2,
  Bot,
  User,
  ShieldAlert,
  AlertTriangle,
  Zap,
  Info,
  ChevronDown,
  ChevronUp,
  FileCode,
  CornerDownLeft,
} from "lucide-react";
import { Finding } from "../review/FindingCard";
import { useFindingDiscussion } from "@/hooks/useUnifiedChat";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { cn } from "@/utils/cn";

interface FindingDiscussionDrawerProps {
  finding: Finding | null;
  isOpen: boolean;
  onClose: () => void;
  repositoryId?: string;
}

const SUGGESTED_QUESTIONS = [
  {
    icon: "⚡",
    label: "Why is this a problem?",
    text: "Why is this a problem in this code?",
  },
  {
    icon: "🚀",
    label: "Why is your suggested approach better?",
    text: "Why is your suggested approach better than what is currently written?",
  },
  {
    icon: "💡",
    label: "Can this be optimized further?",
    text: "Can this code be optimized even further?",
  },
  {
    icon: "📋",
    label: "Show me an example",
    text: "Show me a concrete, production-ready example of how to implement the fix.",
  },
  {
    icon: "⚠️",
    label: "What would happen in production?",
    text: "What would happen in production if this issue is not fixed?",
  },
  {
    icon: "🔄",
    label: "Is there an alternative solution?",
    text: "Is there an alternative solution or architecture pattern for this?",
  },
];

export const FindingDiscussionDrawer: React.FC<
  FindingDiscussionDrawerProps
> = ({ finding, isOpen, onClose, repositoryId }) => {
  const [inputText, setInputText] = useState("");
  const [showFindingContext, setShowFindingContext] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages,
    isLoading,
    isStreaming,
    streamedText,
    sendMessage,
    clearHistory,
    isClearing,
  } = useFindingDiscussion(finding?.id || null, repositoryId);

  // Auto scroll to bottom when messages or streamed text updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamedText, isStreaming]);

  // Focus textarea when drawer opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 200);
    }
  }, [isOpen, finding?.id]);

  if (!isOpen || !finding) return null;

  const handleSend = (textToSend?: string) => {
    const text = textToSend || inputText;
    if (!text.trim() || isStreaming) return;
    sendMessage(text.trim());
    setInputText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  };

  const sev = (finding.severity || "Info").toLowerCase();
  const getSeverityIcon = () => {
    if (sev === "critical")
      return <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />;
    if (sev === "major" || sev === "warning")
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
    if (sev === "minor") return <Zap className="w-3.5 h-3.5 text-blue-400" />;
    return <Info className="w-3.5 h-3.5 text-teal-400" />;
  };

  return (
    <aside
      className={cn(
        "fixed inset-y-0 right-0 z-50 w-full sm:w-[540px] lg:w-[600px] flex flex-col",
        "bg-slate-950/95 backdrop-blur-md text-slate-100 shadow-2xl border-l border-slate-800",
        "transition-transform duration-300 ease-out transform",
        isOpen ? "translate-x-0" : "translate-x-full",
      )}
      aria-label="Finding Discussion Panel"
    >
      {/* 1. Header */}
      <div className="p-4 border-b border-slate-800/80 bg-slate-900/80 shrink-0">
        <div className="flex items-center justify-between gap-2 mb-2">
          {/* Scoped Indicator Badge */}
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-signal-500/10 text-signal-400 border border-signal-500/30">
              <Sparkles className="w-3 h-3 animate-pulse" />
              Scoped Discussion
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              {finding.file_path}
              {finding.line_number ? `:${finding.line_number}` : ""}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                onClick={() => {
                  if (
                    window.confirm("Clear this finding discussion history?")
                  ) {
                    clearHistory();
                  }
                }}
                disabled={isClearing || isStreaming}
                type="button"
                className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-rose-400 transition-colors"
                title="Clear conversation"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onClose}
              type="button"
              className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
              title="Close discussion panel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Finding Title & Severity */}
        <div className="flex items-start gap-2 mt-1">
          <div className="mt-0.5 shrink-0">{getSeverityIcon()}</div>
          <h3 className="text-sm font-semibold text-slate-100 leading-snug line-clamp-2">
            {finding.title}
          </h3>
        </div>

        {/* Collapsible Reference of Finding & Code */}
        <div className="mt-2.5 pt-2 border-t border-slate-800/60">
          <button
            onClick={() => setShowFindingContext(!showFindingContext)}
            type="button"
            className="flex items-center justify-between w-full text-left text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-signal-400" />
              Original Finding & Suggestion Reference
            </span>
            {showFindingContext ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>

          {showFindingContext && (
            <div className="mt-2 p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs space-y-2 max-h-48 overflow-y-auto scrollbar-thin">
              <div>
                <span className="font-semibold text-slate-300 block mb-0.5">
                  Explanation:
                </span>
                <p className="text-slate-400">{finding.description}</p>
              </div>
              {finding.recommendation && (
                <div>
                  <span className="font-semibold text-teal-400 block mb-0.5">
                    Recommendation:
                  </span>
                  <p className="text-slate-400">{finding.recommendation}</p>
                </div>
              )}
              {finding.code_suggestion && (
                <div>
                  <span className="font-semibold text-slate-300 block mb-0.5">
                    Suggested Fix:
                  </span>
                  <pre className="p-2 rounded bg-slate-950 font-mono text-[11px] text-slate-200 overflow-x-auto">
                    <code>{finding.code_suggestion}</code>
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 2. Messages Body */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 bg-slate-950 scrollbar-thin scrollbar-thumb-slate-800">
        {isLoading && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400 gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-signal-400" />
            <span className="text-xs">Loading finding discussion...</span>
          </div>
        ) : messages.length === 0 && !streamedText && !isStreaming ? (
          /* Empty State with Suggested Questions */
          <div className="flex flex-col items-center justify-center min-h-[320px] text-center px-4 py-8">
            <div className="w-12 h-12 rounded-2xl bg-signal-500/10 border border-signal-500/30 flex items-center justify-center mb-4 text-signal-400 shadow-lg shadow-teal-500/10">
              <Sparkles className="w-6 h-6" />
            </div>
            <h4 className="text-base font-semibold text-slate-100">
              Discuss this Review Finding
            </h4>
            <p className="text-xs text-slate-400 mt-1 max-w-sm">
              Ask why this finding was raised, explore runtime tradeoffs,
              examine edge cases, or request an alternative implementation.
            </p>

            {/* Suggested Follow-Up Prompt Cards */}
            <div className="grid grid-cols-1 gap-2 w-full mt-6 text-left">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1 px-1">
                Suggested Follow-up Questions
              </span>
              {SUGGESTED_QUESTIONS.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSend(q.text)}
                  type="button"
                  className="flex items-center gap-2.5 p-3 rounded-lg border border-slate-800/90 bg-slate-900/60 hover:bg-slate-900 hover:border-signal-500/50 text-xs text-slate-200 hover:text-white transition-all text-left group shadow-sm"
                >
                  <span className="text-base shrink-0">{q.icon}</span>
                  <span className="flex-1 font-medium">{q.label}</span>
                  <span className="text-slate-600 group-hover:text-signal-400 transition-colors text-xs font-sans">
                    &rarr;
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, index) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={msg.id || index}
                  className={cn(
                    "flex items-start gap-3",
                    isUser ? "justify-end" : "justify-start",
                  )}
                >
                  {!isUser && (
                    <div className="w-7 h-7 rounded-lg bg-signal-500/10 border border-signal-500/30 flex items-center justify-center text-signal-400 shrink-0 mt-1 shadow-sm">
                      <Bot className="w-4 h-4" />
                    </div>
                  )}

                  <div
                    className={cn(
                      "max-w-[88%] rounded-xl px-4 py-3 text-sm shadow-sm",
                      isUser
                        ? "bg-signal-600 text-white rounded-tr-none"
                        : "bg-slate-900 border border-slate-800 text-slate-100 rounded-tl-none",
                    )}
                  >
                    {isUser ? (
                      <p className="whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </p>
                    ) : (
                      <MarkdownRenderer content={msg.content} />
                    )}
                  </div>

                  {isUser && (
                    <div className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0 mt-1 shadow-sm">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Real-time Streaming AI Response */}
            {isStreaming && (
              <div className="flex items-start gap-3 justify-start animate-in fade-in duration-200">
                <div className="w-7 h-7 rounded-lg bg-signal-500/10 border border-signal-500/30 flex items-center justify-center text-signal-400 shrink-0 mt-1 shadow-sm">
                  <Bot className="w-4 h-4" />
                </div>
                <div className="max-w-[88%] rounded-xl rounded-tl-none bg-slate-900 border border-slate-800 p-4 text-sm text-slate-100 shadow-sm w-full">
                  {streamedText ? (
                    <MarkdownRenderer content={streamedText} />
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-signal-400" />
                      <span>Thinking and analyzing code context...</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 3. Bottom Fixed Input Bar */}
      <div className="p-3.5 sm:p-4 bg-slate-900/90 border-t border-slate-800 shrink-0">
        {/* Quick Question Chips above input during active conversation */}
        {messages.length > 0 && !isStreaming && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 mb-2 scrollbar-none">
            {SUGGESTED_QUESTIONS.slice(0, 4).map((q, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(q.text)}
                type="button"
                className="whitespace-nowrap px-2.5 py-1 rounded-full text-[11px] bg-slate-800/90 hover:bg-slate-800 text-slate-300 hover:text-signal-300 border border-slate-700/80 transition-colors shrink-0"
              >
                {q.icon} {q.label}
              </button>
            ))}
          </div>
        )}

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="relative flex items-end gap-2 bg-slate-950 rounded-xl border border-slate-800 focus-within:border-signal-500/80 focus-within:ring-1 focus-within:ring-signal-500/40 p-2 shadow-inner"
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={inputText}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            placeholder={`Ask about "${finding.title.slice(0, 35)}..."`}
            disabled={isStreaming}
            className="flex-1 bg-transparent border-0 resize-none text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 px-2 py-1 max-h-36 leading-relaxed"
          />

          <button
            type="submit"
            disabled={!inputText.trim() || isStreaming}
            className="p-2 rounded-lg bg-signal-500 hover:bg-signal-600 disabled:opacity-40 disabled:hover:bg-signal-500 text-white transition-all shrink-0 shadow-sm"
            title="Send message (Enter)"
          >
            {isStreaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>

        <div className="flex items-center justify-between text-[10px] text-slate-500 mt-2 px-1">
          <span>AI has context of this finding and surrounding diff.</span>
          <span className="flex items-center gap-1 font-mono">
            <CornerDownLeft className="w-3 h-3" /> Enter to send • Shift+Enter
            for newline
          </span>
        </div>
      </div>
    </aside>
  );
};
