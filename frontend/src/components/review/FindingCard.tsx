import React, { useState } from "react";
import {
  MessageSquare,
  Sparkles,
  AlertTriangle,
  ShieldAlert,
  Zap,
  Info,
  CheckCircle,
  FileCode,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/utils/cn";

export interface Finding {
  id: string;
  review_id?: string;
  severity: "Critical" | "Major" | "Minor" | "Info" | string;
  category: "security" | "correctness" | "performance" | "maintainability" | "best_practices" | "testing" | string;
  file_path: string;
  line_number: number | null;
  title: string;
  description: string;
  recommendation: string;
  code_suggestion?: string | null;
}

interface FindingCardProps {
  finding: Finding;
  onDiscuss: (finding: Finding) => void;
  isActive?: boolean;
  onJumpToCode?: (filePath: string, line: number | null) => void;
}

export const FindingCard: React.FC<FindingCardProps> = ({
  finding,
  onDiscuss,
  isActive = false,
  onJumpToCode,
}) => {
  const [copied, setCopied] = useState(false);
  const [showFullSuggestion, setShowFullSuggestion] = useState(true);

  const sev = (finding.severity || "Info").toLowerCase();
  const isCritical = sev === "critical";
  const isMajor = sev === "major" || sev === "warning";
  const isMinor = sev === "minor";

  const getSeverityBadge = () => {
    if (isCritical) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
          <ShieldAlert className="w-3.5 h-3.5" />
          Critical Severity
        </span>
      );
    }
    if (isMajor) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
          <AlertTriangle className="w-3.5 h-3.5" />
          Major Issue
        </span>
      );
    }
    if (isMinor) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
          <Zap className="w-3.5 h-3.5" />
          Minor Improvement
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-teal-500/10 text-teal-400 border border-teal-500/30">
        <Info className="w-3.5 h-3.5" />
        Info
      </span>
    );
  };

  const handleCopy = () => {
    if (!finding.code_suggestion) return;
    navigator.clipboard.writeText(finding.code_suggestion);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      id={`finding-${finding.id}`}
      className={cn(
        "group relative rounded-xl border transition-all duration-200 shadow-sm",
        "bg-surface-light dark:bg-slate-900/90",
        isActive
          ? "border-signal-500 ring-2 ring-signal-500/30 dark:border-signal-400 shadow-teal-500/10 shadow-lg"
          : "border-border-light dark:border-slate-800 hover:border-slate-700 dark:hover:border-slate-700"
      )}
    >
      {/* Top Header */}
      <div className="p-4 sm:p-5 border-b border-border-light/60 dark:border-slate-800/80">
        <div className="flex flex-wrap items-center justify-between gap-2.5 mb-2.5">
          <div className="flex items-center gap-2">
            {getSeverityBadge()}
            <span className="text-xs uppercase font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-medium">
              {finding.category || "General"}
            </span>
          </div>

          {/* Discuss with AI Trigger */}
          <button
            onClick={() => onDiscuss(finding)}
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 shadow-sm",
              isActive
                ? "bg-signal-500 text-white ring-2 ring-signal-400/40 shadow-signal-500/20"
                : "bg-signal-500/10 text-signal-600 dark:text-signal-400 border border-signal-500/30 hover:bg-signal-500 hover:text-white dark:hover:bg-signal-500 dark:hover:text-white"
            )}
          >
            <Sparkles className="w-3.5 h-3.5 animate-pulse" />
            <span>{isActive ? "Discussion Open" : "Discuss with AI"}</span>
          </button>
        </div>

        {/* Finding Title */}
        <h4 className="text-base font-semibold text-slate-900 dark:text-slate-100 leading-snug">
          {finding.title}
        </h4>

        {/* File & Line Tag */}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => onJumpToCode?.(finding.file_path, finding.line_number)}
            type="button"
            className="inline-flex items-center gap-1 text-xs font-mono text-slate-500 dark:text-slate-400 hover:text-signal-500 dark:hover:text-signal-400 transition-colors"
          >
            <FileCode className="w-3.5 h-3.5 text-signal-500" />
            <span className="underline decoration-dotted underline-offset-2">
              {finding.file_path}
              {finding.line_number ? `:${finding.line_number}` : ""}
            </span>
          </button>
        </div>
      </div>

      {/* Description & Recommendation Body */}
      <div className="p-4 sm:p-5 space-y-4 text-sm text-slate-700 dark:text-slate-300">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 block mb-1">
            Analysis
          </span>
          <p className="leading-relaxed whitespace-pre-wrap">{finding.description}</p>
        </div>

        {finding.recommendation && (
          <div className="p-3 rounded-lg bg-teal-500/5 dark:bg-teal-500/10 border border-teal-500/20 text-xs">
            <span className="font-semibold text-teal-700 dark:text-teal-300 block mb-0.5">
              💡 Recommendation
            </span>
            <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
              {finding.recommendation}
            </p>
          </div>
        )}

        {/* Suggested Code Block */}
        {finding.code_suggestion && (
          <div className="mt-3 rounded-lg overflow-hidden border border-slate-700/60 bg-slate-950">
            <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-900 border-b border-slate-800 text-[11px] font-mono text-slate-400">
              <span className="font-medium text-slate-300 flex items-center gap-1.5">
                <FileCode className="w-3 h-3 text-signal-400" /> Suggested Fix
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopy}
                  type="button"
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      <span className="text-emerald-400 font-sans">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span className="font-sans">Copy</span>
                    </>
                  )}
                </button>
                <button
                  onClick={() => setShowFullSuggestion(!showFullSuggestion)}
                  type="button"
                  className="text-slate-400 hover:text-slate-200"
                >
                  {showFullSuggestion ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>

            {showFullSuggestion && (
              <pre className="p-3 text-xs font-mono overflow-x-auto text-slate-100 leading-relaxed max-h-60 scrollbar-thin scrollbar-thumb-slate-700">
                <code>{finding.code_suggestion}</code>
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Card Footer with Quick Discuss Action */}
      <div className="px-4 sm:px-5 py-3 bg-slate-50/70 dark:bg-slate-900/50 rounded-b-xl border-t border-border-light/40 dark:border-slate-800/60 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>Grounded on PR commit diff</span>
        <button
          onClick={() => onDiscuss(finding)}
          type="button"
          className="font-medium text-signal-600 dark:text-signal-400 hover:underline flex items-center gap-1"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Ask question about this finding &rarr;
        </button>
      </div>
    </div>
  );
};
