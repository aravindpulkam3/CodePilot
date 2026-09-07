import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, FileWarning } from "lucide-react";
import { cn } from "@/utils/cn";
import { ChangedFile, Finding, compareBySeverity, getFindingsForFile, getSeverityStyle } from "@/types/reviewTypes";

interface ChangedFilesRailProps {
  files: ChangedFile[];
  findings: Finding[];
  changedFilesCount: number;
  selectedFile: string | null;
  onSelectFile: (filename: string) => void;
  onSelectFinding: (finding: Finding, filename: string | null) => void;
  activeFindingId: string | null;
}

interface FileGroup {
  file: ChangedFile;
  findings: Finding[];
}

/**
 * Flat, expandable changed-files navigator — a flush IDE-style pane (no
 * Card wrapper), matching the "Changed Files" tree from the redesign brief.
 * Findings nest under the file they belong to; findings matching no file
 * (hallucinated path, or a file beyond GitHub's 30-file page limit) land
 * in a trailing "Other findings" group rather than being silently dropped.
 */
export function ChangedFilesRail({
  files,
  findings,
  changedFilesCount,
  selectedFile,
  onSelectFile,
  onSelectFinding,
  activeFindingId,
}: ChangedFilesRailProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { groups, unmatched } = useMemo(() => {
    const matched = new Set<Finding>();

    const groups: FileGroup[] = files.map((file) => {
      const fileFindings = getFindingsForFile(findings, file);
      fileFindings.forEach((f) => matched.add(f));
      return { file, findings: fileFindings.sort(compareBySeverity) };
    });

    const unmatched = findings.filter((f) => !matched.has(f)).sort(compareBySeverity);

    return { groups, unmatched };
  }, [files, findings]);

  const toggle = (filename: string) =>
    setExpanded((prev) => ({ ...prev, [filename]: !prev[filename] }));

  return (
    <div className="thin-scrollbar flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border-light dark:border-border-dark">
      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-light dark:text-muted-dark">
        Changed Files
      </div>

      {groups.map(({ file, findings: fileFindings }) => {
        const isBinary = !file.patch;
        const isSelected = selectedFile === file.filename;
        const isExpanded = !!expanded[file.filename];

        return (
          <div key={file.filename}>
            <div
              className={cn(
                "group flex items-center gap-1 px-2 py-1.5 text-sm",
                isSelected && "bg-signal-50 dark:bg-signal-500/10",
              )}
            >
              <button
                type="button"
                onClick={() => toggle(file.filename)}
                className="shrink-0 rounded p-0.5 text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
                title={isExpanded ? "Collapse findings" : "Expand findings"}
              >
                {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => !isBinary && onSelectFile(file.filename)}
                disabled={isBinary}
                className={cn(
                  "min-w-0 flex-1 truncate text-left font-mono text-xs",
                  isBinary
                    ? "cursor-not-allowed text-muted-light/60 dark:text-muted-dark/60"
                    : isSelected
                      ? "text-ink-light dark:text-ink-dark"
                      : "text-ink-light/90 hover:text-ink-light dark:text-ink-dark/90 dark:hover:text-ink-dark",
                )}
                title={file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename}
              >
                {file.filename}
              </button>
              {isBinary ? (
                <span className="shrink-0 text-[10px] text-muted-light dark:text-muted-dark">binary</span>
              ) : (
                <span className="shrink-0 font-mono text-[10px]">
                  <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
                  <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
                </span>
              )}
              {fileFindings.length > 0 && (
                <span className="shrink-0 rounded-full bg-black/[.05] px-1.5 py-0.5 text-[10px] font-medium text-muted-light dark:bg-white/[.08] dark:text-muted-dark">
                  {fileFindings.length}
                </span>
              )}
            </div>

            {isExpanded && fileFindings.length > 0 && (
              <div className="pb-1">
                {fileFindings.map((finding) => (
                  <button
                    key={finding.id}
                    type="button"
                    onClick={() => onSelectFinding(finding, file.filename)}
                    className={cn(
                      "flex w-full items-start gap-1.5 py-1 pl-8 pr-2 text-left text-xs",
                      activeFindingId === finding.id
                        ? "bg-signal-50 dark:bg-signal-500/10"
                        : "hover:bg-black/[.02] dark:hover:bg-white/[.03]",
                    )}
                  >
                    <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", getSeverityStyle(finding.severity).dot)} />
                    <span className="truncate text-ink-light/90 dark:text-ink-dark/90">{finding.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {changedFilesCount > files.length && (
        <div className="px-3 py-2 text-[11px] text-muted-light dark:text-muted-dark">
          Showing {files.length} of {changedFilesCount} changed files
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="mt-2 border-t border-border-light dark:border-border-dark">
          <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-light dark:text-muted-dark">
            <FileWarning className="h-3 w-3" /> Other findings
          </div>
          {unmatched.map((finding) => (
            <button
              key={finding.id}
              type="button"
              onClick={() => onSelectFinding(finding, null)}
              className={cn(
                "flex w-full items-start gap-1.5 px-3 py-1.5 text-left text-xs",
                activeFindingId === finding.id
                  ? "bg-signal-50 dark:bg-signal-500/10"
                  : "hover:bg-black/[.02] dark:hover:bg-white/[.03]",
              )}
              title={finding.file_path}
            >
              <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", getSeverityStyle(finding.severity).dot)} />
              <span className="min-w-0 flex-1 truncate text-ink-light/90 dark:text-ink-dark/90">{finding.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
