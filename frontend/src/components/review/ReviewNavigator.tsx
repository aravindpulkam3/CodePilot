import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { AlignLeft, PanelLeftOpen, Search } from "lucide-react";
import { cn } from "@/utils/cn";
import { ChangedFile, Finding, severityKey, severityRank } from "@/types/reviewTypes";
import { basename, groupFilesByDirectory, orderFindings } from "@/utils/reviewNavigation";
import { SeverityIcon } from "./SeverityIcon";

interface ReviewNavigatorProps {
  files: ChangedFile[];
  findings: Finding[];
  changedFilesCount: number;
  view: "overview" | "file";
  selectedFile: string | null;
  activeFindingId: string | null;
  reviewScore: number | null;
  onSelectOverview: () => void;
  onSelectFile: (filename: string) => void;
  onSelectFinding: (finding: Finding, filename: string | null) => void;
  onCollapse: () => void;
  filterInputRef: RefObject<HTMLInputElement>;
  className?: string;
}

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  removed: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
  changed: "M",
};

const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous finding"],
  ["] / [", "Next / previous file"],
  ["o", "Overview"],
  ["d", "Discuss"],
  ["/", "Filter files"],
  ["Esc", "Close discussion, then clear finding"],
];

// Selected rows: one neutral fill plus a 2px teal bar — the only use of the
// accent in the navigator, so "where am I" is never ambiguous.
const SELECTED =
  "bg-rv-sel text-rv-ink before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-rv-teal";

/**
 * The one "go somewhere" surface: Overview, then every changed file grouped
 * by directory, with its findings nested under it. Severity is shown calmly
 * (only Critical/Major in color); findings matching no changed file are
 * listed under "Outside this diff" rather than dropped.
 */
export function ReviewNavigator({
  files,
  findings,
  changedFilesCount,
  view,
  selectedFile,
  activeFindingId,
  reviewScore,
  onSelectOverview,
  onSelectFile,
  onSelectFinding,
  onCollapse,
  filterInputRef,
  className,
}: ReviewNavigatorProps) {
  const [filter, setFilter] = useState("");
  const [onlyWithFindings, setOnlyWithFindings] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showShortcuts, setShowShortcuts] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const { byFile, unmatched } = useMemo(() => {
    const byFile = new Map<string, Finding[]>();
    const unmatched: Finding[] = [];
    for (const { finding, filename } of orderFindings(files, findings)) {
      if (filename === null) unmatched.push(finding);
      else byFile.set(filename, [...(byFile.get(filename) ?? []), finding]);
    }
    return { byFile, unmatched };
  }, [files, findings]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const visible = files.filter(
      (f) =>
        (!needle || f.filename.toLowerCase().includes(needle)) &&
        (!onlyWithFindings || (byFile.get(f.filename)?.length ?? 0) > 0),
    );
    return groupFilesByDirectory(visible);
  }, [files, filter, onlyWithFindings, byFile]);

  // Keep the current row in view when selection moves by keyboard.
  const activeKey = activeFindingId ? `f:${activeFindingId}` : selectedFile ? `file:${selectedFile}` : null;
  useEffect(() => {
    if (activeKey) rowRefs.current.get(activeKey)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const register = (key: string) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };

  const toggleExpanded = (filename: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });

  const findingRow = (finding: Finding, filename: string | null) => (
    <button
      key={finding.id}
      ref={register(`f:${finding.id}`)}
      type="button"
      onClick={() => onSelectFinding(finding, filename)}
      title={finding.title}
      className={cn(
        "relative flex h-6 w-full items-center gap-2 pl-[29px] pr-3 text-left text-xs text-rv-ink2",
        activeFindingId === finding.id ? SELECTED : "hover:bg-rv-hover",
      )}
    >
      <SeverityIcon severity={finding.severity} calm />
      <span className="min-w-0 flex-1 truncate">{finding.title}</span>
      <span className="shrink-0 font-mono text-[11px] text-rv-mute">{finding.line_number ?? "file"}</span>
    </button>
  );

  return (
    <nav
      aria-label="Changed files"
      className={cn("flex min-h-0 w-[280px] shrink-0 flex-col border-r border-rv-hair bg-rv-chrome", className)}
    >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-rv-hair p-2">
        <button
          type="button"
          onClick={onSelectOverview}
          className={cn(
            "relative flex h-[26px] items-center gap-2 pl-2.5 pr-2 text-left text-[13px] text-rv-ink2",
            view === "overview" && !activeFindingId ? SELECTED : "hover:bg-rv-hover",
          )}
        >
          <AlignLeft className="h-3.5 w-3.5 text-rv-mute" />
          Overview
          {reviewScore !== null && (
            <span className="ml-auto font-mono text-[11px] text-rv-mute">
              {reviewScore} · {findings.length}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2.5">
          <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded border border-rv-hair bg-rv-rec px-2 text-xs text-rv-mute focus-within:border-rv-bd">
            <Search className="h-3 w-3 shrink-0" />
            <input
              ref={filterInputRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFilter("");
                  e.currentTarget.blur();
                }
              }}
              placeholder="Filter files"
              aria-label="Filter files"
              className="min-w-0 flex-1 bg-transparent text-rv-ink placeholder:text-rv-mute focus:outline-none"
            />
            <kbd className="font-mono text-[10px] text-rv-lnc">/</kbd>
          </label>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-rv-mute">
            <input
              type="checkbox"
              checked={onlyWithFindings}
              onChange={(e) => setOnlyWithFindings(e.target.checked)}
              className="h-3 w-3 accent-[var(--rv-teal)]"
            />
            With findings
          </label>
        </div>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <p className="px-3 py-3 text-xs text-rv-mute">
            {files.length === 0 ? "No changed files." : "No files match."}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.dir || "/"}>
            {group.dir && (
              <div className="flex h-[26px] items-end px-3 pb-1 font-mono text-[11px] leading-[14px] text-rv-mute" title={group.dir}>
                <span className="rv-truncate-start block min-w-0">
                  <span>{group.dir}</span>
                </span>
              </div>
            )}
            {group.files.map((file) => {
              const fileFindings = byFile.get(file.filename) ?? [];
              const isCurrent = view === "file" && selectedFile === file.filename;
              const isSelected = isCurrent && !activeFindingId;
              const isOpen = isCurrent || expanded.has(file.filename);
              const worst = fileFindings.reduce<Finding | null>(
                (acc, f) => (!acc || severityRank(f.severity) < severityRank(acc.severity) ? f : acc),
                null,
              );
              return (
                <div key={file.filename}>
                  <button
                    ref={register(`file:${file.filename}`)}
                    type="button"
                    onClick={() => onSelectFile(file.filename)}
                    title={file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename}
                    className={cn(
                      "relative flex h-[26px] w-full items-center gap-2 px-3 text-left text-[13px]",
                      isSelected ? SELECTED : isCurrent ? "text-rv-ink" : "text-rv-ink2 hover:bg-rv-hover",
                    )}
                  >
                    <span className="w-[9px] shrink-0 font-mono text-[10px] text-rv-lnc">
                      {STATUS_LETTER[file.status] ?? "M"}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate", isCurrent && "font-semibold", !file.patch && "text-rv-mute")}>
                      {basename(file.filename)}
                    </span>
                    {worst ? (
                      // Clicking the count peeks at another file's findings
                      // without leaving the current one.
                      <span
                        className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-rv-mute"
                        title={isCurrent ? undefined : "Show findings"}
                        onClick={(e) => {
                          if (isCurrent) return;
                          e.stopPropagation();
                          toggleExpanded(file.filename);
                        }}
                      >
                        <SeverityIcon severity={worst.severity} calm />
                        {fileFindings.length}
                      </span>
                    ) : (
                      !file.patch && <span className="shrink-0 font-mono text-[11px] text-rv-mute">no diff</span>
                    )}
                  </button>
                  {isOpen && fileFindings.map((f) => findingRow(f, file.filename))}
                </div>
              );
            })}
          </div>
        ))}

        {unmatched.length > 0 && (
          <div className="mt-1 border-t border-rv-hair pt-1">
            <div className="flex h-[26px] items-end px-3 pb-1 text-[11px] text-rv-mute">Outside this diff</div>
            {unmatched.map((f) => findingRow(f, null))}
          </div>
        )}

        {changedFilesCount > files.length && (
          <p className="px-3 pb-2 pt-3 text-[11px] leading-4 text-rv-mute">
            GitHub returns at most {files.length} files for a pull request, so {changedFilesCount - files.length} of{" "}
            {changedFilesCount} changed files aren't listed here.
          </p>
        )}
      </div>

      {showShortcuts && (
        <dl className="shrink-0 border-t border-rv-hair px-3 py-2 text-[11px] leading-5">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className="flex justify-between gap-3">
              <dt className="font-mono text-rv-ink2">{keys}</dt>
              <dd className="text-rv-mute">{action}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex shrink-0 items-center gap-3 border-t border-rv-hair px-3 py-2 text-[11px] text-rv-mute">
        <span className="min-w-0 flex-1 truncate">
          {changedFilesCount > files.length
            ? `${files.length} of ${changedFilesCount} files`
            : `${files.length} ${files.length === 1 ? "file" : "files"} changed`}
        </span>
        <button type="button" onClick={() => setShowShortcuts((v) => !v)} className="hover:text-rv-ink" aria-expanded={showShortcuts}>
          Shortcuts
        </button>
        <button type="button" onClick={onCollapse} className="hover:text-rv-ink">
          Hide
        </button>
      </div>
    </nav>
  );
}

/**
 * The navigator collapsed to a 40px strip — what the layout falls back to
 * when keeping it docked would squeeze the code under ~80 characters.
 */
export function ReviewNavigatorStrip({
  findings,
  onExpand,
  onOverview,
}: {
  findings: Finding[];
  onExpand: () => void;
  onOverview: () => void;
}) {
  const critical = findings.filter((f) => severityKey(f.severity) === "critical").length;
  const major = findings.filter((f) => severityKey(f.severity) === "major").length;
  const iconButton = "flex h-7 w-7 items-center justify-center rounded text-rv-mute hover:bg-rv-hover hover:text-rv-ink";

  return (
    <nav aria-label="Changed files (collapsed)" className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-rv-hair bg-rv-chrome py-2">
      <button type="button" onClick={onExpand} aria-label="Show files" title="Show files" className={iconButton}>
        <PanelLeftOpen className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={onOverview} aria-label="Overview" title="Overview" className={iconButton}>
        <AlignLeft className="h-3.5 w-3.5" />
      </button>
      {(critical > 0 || major > 0) && <span className="my-1 h-px w-4 bg-rv-hair" />}
      {critical > 0 && (
        <span className="flex flex-col items-center gap-0.5 font-mono text-[10px] text-rv-mute" title={`${critical} critical`}>
          <SeverityIcon severity="critical" />
          {critical}
        </span>
      )}
      {major > 0 && (
        <span className="flex flex-col items-center gap-0.5 font-mono text-[10px] text-rv-mute" title={`${major} major`}>
          <SeverityIcon severity="major" />
          {major}
        </span>
      )}
    </nav>
  );
}
