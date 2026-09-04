import { Code, BookOpen } from "lucide-react";
import { cn } from "@/utils/cn";

interface SourceListProps {
  sources: any[];
  onSourceSelect?: (source: any) => void;
  selectedSourceId?: string;
}

export function SourceList({
  sources,
  onSourceSelect,
  selectedSourceId,
}: SourceListProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((source, i) => {
        const filePath = source.filePath || source.file_path || "Unknown";
        const fileName = filePath.split("/").pop() || "Unknown";
        const lineStart = source.lineStart || source.start_line || "?";

        // Documentation sections are cited by heading rather than by line
        // range — "README.md § Getting Started" is what the user actually
        // recognises, and the distinction matters because docs describe
        // intended behaviour while code shows actual behaviour.
        const isDoc =
          source.sourceKind === "documentation" || source.symbolType === "documentation";
        const sectionPath = source.sectionPath || source.symbolName;

        // Unique ID to identify selection state
        const sourceId = `${filePath}:${lineStart}:${i}`;
        const isSelected = selectedSourceId === sourceId;

        return (
          <button
            key={i}
            onClick={() => onSourceSelect?.({ ...source, id: sourceId })}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors shadow-sm",
              isSelected
                ? "bg-signal-500 border-signal-600 text-white"
                : isDoc
                  ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
                  : "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50",
            )}
            title={isDoc ? `${filePath} § ${sectionPath}` : `${filePath}:${lineStart}`}
          >
            {isDoc ? <BookOpen className="h-3 w-3" /> : <Code className="h-3 w-3" />}
            <span className="font-mono font-medium">{fileName}</span>
            {isDoc ? (
              <span className="max-w-[14rem] truncate text-[10px] opacity-80">§ {sectionPath}</span>
            ) : (
              <span className="text-[10px] opacity-80">L{lineStart}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
