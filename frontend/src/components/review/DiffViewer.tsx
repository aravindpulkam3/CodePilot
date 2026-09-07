import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { cn } from "@/utils/cn";
import { parseDiff, DiffLine, DiffHunk } from "@/utils/parseDiff";
import { languageForFilename, highlightLine } from "@/utils/prismLang";
import { ChangedFile, Finding, getSeverityStyle } from "@/types/reviewTypes";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";

interface DiffViewerProps {
  file: ChangedFile;
  findings: Finding[]; // already filtered to this file (getFindingsForFile)
  activeFindingId: string | null;
  onAskAi: (finding: Finding) => void;
}

const GRID_COLS = "3.5rem 3.5rem 1.5rem 1fr";

/**
 * Renders one file's diff hunks with gutters, +/- line tinting, and Prism
 * syntax highlighting, plus inline finding annotations anchored to the
 * line they describe. No `Card` wrapper — this pane fills its space
 * edge-to-edge, the dominant region of the PR Review workspace.
 */
export function DiffViewer({ file, findings, activeFindingId, onAskAi }: DiffViewerProps) {
  const hunks = useMemo(() => parseDiff(file.patch), [file.patch]);
  const language = useMemo(() => languageForFilename(file.filename), [file.filename]);

  const [manuallyExpanded, setManuallyExpanded] = useState<Set<string>>(new Set());
  const [flashId, setFlashId] = useState<string | null>(null);

  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const fileLevelRef = useRef<HTMLDivElement>(null);

  // Which new-file line numbers are actually rendered (add/context lines
  // only — line_number refers to the new side, so a del-only line can
  // never be a valid anchor).
  const { findingsByLine, unanchored } = useMemo(() => {
    const renderedNewLines = new Set<number>();
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if ((line.type === "add" || line.type === "context") && line.newLine !== null) {
          renderedNewLines.add(line.newLine);
        }
      }
    }
    const byLine = new Map<number, Finding[]>();
    const unanchored: Finding[] = [];
    for (const finding of findings) {
      if (finding.line_number !== null && renderedNewLines.has(finding.line_number)) {
        const list = byLine.get(finding.line_number) || [];
        list.push(finding);
        byLine.set(finding.line_number, list);
      } else {
        unanchored.push(finding);
      }
    }
    return { findingsByLine: byLine, unanchored };
  }, [hunks, findings]);

  const activeFinding = useMemo(
    () => findings.find((f) => f.id === activeFindingId) || null,
    [findings, activeFindingId]
  );
  const activeIsUnanchored = !!activeFinding && unanchored.includes(activeFinding);

  useEffect(() => {
    if (!activeFindingId) return;
    setFlashId(activeFindingId);
    const timer = setTimeout(() => setFlashId(null), 1600);

    if (activeIsUnanchored) {
      fileLevelRef.current?.scrollIntoView({ block: "start" });
    } else if (activeFinding?.line_number !== null && activeFinding !== null) {
      const el = lineRefs.current.get(activeFinding!.line_number!);
      el?.scrollIntoView({ block: "center" });
    }
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFindingId]);

  const isExpanded = (findingId: string) => manuallyExpanded.has(findingId) || findingId === activeFindingId;
  const toggleExpanded = (findingId: string) => {
    setManuallyExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(findingId)) next.delete(findingId);
      else next.add(findingId);
      return next;
    });
  };

  if (!file.patch) {
    return (
      <div className="flex flex-1 min-w-0 flex-col">
        <FileHeader file={file} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-light dark:text-muted-dark">
          Binary file or diff not available for this file.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-w-0 flex-col">
      <FileHeader file={file} />
      <div className="thin-scrollbar flex-1 min-h-0 overflow-auto">
        {unanchored.length > 0 && (
          <div ref={fileLevelRef} className="border-b border-border-light dark:border-border-dark p-3 space-y-2">
            {unanchored.map((finding) => (
              <FindingAnnotation
                key={finding.id}
                finding={finding}
                onAskAi={onAskAi}
                flashing={flashId === finding.id}
                fileLevel
              />
            ))}
          </div>
        )}

        <div className="prism-code font-mono text-xs" style={{ display: "grid", gridTemplateColumns: GRID_COLS }}>
          {hunks.map((hunk, hunkIdx) => (
            <HunkBlock
              key={hunkIdx}
              hunk={hunk}
              language={language}
              findingsByLine={findingsByLine}
              isExpanded={isExpanded}
              toggleExpanded={toggleExpanded}
              onAskAi={onAskAi}
              flashId={flashId}
              lineRefs={lineRefs}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FileHeader({ file }: { file: ChangedFile }) {
  return (
    <div className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b border-border-light bg-surface-light px-3 py-2 dark:border-border-dark dark:bg-surface-dark">
      <span className="truncate font-mono text-xs text-ink-light dark:text-ink-dark">
        {file.previous_filename ? (
          <>
            <span className="text-muted-light dark:text-muted-dark line-through">{file.previous_filename}</span>
            {" → "}
            {file.filename}
          </>
        ) : (
          file.filename
        )}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
        <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
      </span>
    </div>
  );
}

function HunkBlock({
  hunk,
  language,
  findingsByLine,
  isExpanded,
  toggleExpanded,
  onAskAi,
  flashId,
  lineRefs,
}: {
  hunk: DiffHunk;
  language: string;
  findingsByLine: Map<number, Finding[]>;
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  onAskAi: (finding: Finding) => void;
  flashId: string | null;
  lineRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
}) {
  return (
    <>
      <div
        style={{ gridColumn: "1 / -1" }}
        className="bg-black/[.03] px-2 py-1 font-mono text-[11px] text-muted-light dark:bg-white/[.04] dark:text-muted-dark"
      >
        {hunk.header}
      </div>
      {hunk.lines.map((line, idx) => (
        <DiffLineRow
          key={idx}
          line={line}
          language={language}
          findings={line.newLine !== null ? findingsByLine.get(line.newLine) : undefined}
          isExpanded={isExpanded}
          toggleExpanded={toggleExpanded}
          onAskAi={onAskAi}
          flashId={flashId}
          registerRef={(el) => {
            if (line.newLine !== null && el) lineRefs.current.set(line.newLine, el);
          }}
        />
      ))}
    </>
  );
}

function DiffLineRow({
  line,
  language,
  findings,
  isExpanded,
  toggleExpanded,
  onAskAi,
  flashId,
  registerRef,
}: {
  line: DiffLine;
  language: string;
  findings?: Finding[];
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  onAskAi: (finding: Finding) => void;
  flashId: string | null;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  if (line.type === "meta") {
    return (
      <div style={{ gridColumn: "3 / -1" }} className="px-2 py-0.5 text-[11px] italic text-muted-light dark:text-muted-dark">
        {line.content}
      </div>
    );
  }

  const rowBg =
    line.type === "add"
      ? "bg-emerald-50 dark:bg-emerald-500/10"
      : line.type === "del"
        ? "bg-rose-50 dark:bg-rose-500/10"
        : "";
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";

  return (
    <>
      <div className={cn("select-none px-2 text-right text-muted-light dark:text-muted-dark", rowBg)}>
        {line.oldLine ?? ""}
      </div>
      <div className={cn("select-none px-2 text-right text-muted-light dark:text-muted-dark", rowBg)}>
        {line.newLine ?? ""}
      </div>
      <div className={cn("select-none text-center", rowBg)}>{marker}</div>
      {/* display:contents wrappers have no layout box, so scrollIntoView
          on a wrapper ref is unreliable — the ref is attached to this
          content cell instead, which always has real geometry. */}
      <div
        ref={registerRef}
        className={cn("whitespace-pre px-2", rowBg)}
        dangerouslySetInnerHTML={{ __html: highlightLine(line.content || " ", language) }}
      />

      {findings && findings.length > 0 && (
        <div style={{ gridColumn: "1 / -1" }} className="space-y-2 border-y border-border-light/60 p-3 dark:border-border-dark/60">
          {findings.map((finding) =>
            isExpanded(finding.id) ? (
              <FindingAnnotation
                key={finding.id}
                finding={finding}
                onAskAi={onAskAi}
                flashing={flashId === finding.id}
                onCollapse={() => toggleExpanded(finding.id)}
              />
            ) : (
              <button
                key={finding.id}
                type="button"
                onClick={() => toggleExpanded(finding.id)}
                className="flex items-center gap-1.5 text-xs"
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", getSeverityStyle(finding.severity).dot)} />
                <span className={getSeverityStyle(finding.severity).text}>{finding.title}</span>
              </button>
            )
          )}
        </div>
      )}
    </>
  );
}

function FindingAnnotation({
  finding,
  onAskAi,
  flashing,
  fileLevel,
  onCollapse,
}: {
  finding: Finding;
  onAskAi: (finding: Finding) => void;
  flashing: boolean;
  fileLevel?: boolean;
  onCollapse?: () => void;
}) {
  const style = getSeverityStyle(finding.severity);
  const suggestion = finding.code_suggestion
    ? finding.code_suggestion.trim().startsWith("```")
      ? finding.code_suggestion
      : "```\n" + finding.code_suggestion + "\n```"
    : null;

  return (
    <div
      className={cn(
        "rounded border-l-2 p-3 font-sans text-xs transition-colors",
        style.border,
        style.tint,
        flashing && "ring-2 ring-signal-500/60",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className={cn("font-semibold", style.text)}>{style.label}</span>
        <span className="text-muted-light dark:text-muted-dark">{finding.category}</span>
        {fileLevel && (
          <span className="text-muted-light dark:text-muted-dark">· file-level (no reliable line reference)</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAskAi(finding)}
            className="flex items-center gap-1 text-signal-700 hover:underline dark:text-signal-300"
          >
            <MessageSquareText className="h-3 w-3" /> Ask AI
          </button>
          {onCollapse && (
            <button type="button" onClick={onCollapse} className="text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark">
              Collapse
            </button>
          )}
        </div>
      </div>
      <div className="mb-1 font-medium text-ink-light dark:text-ink-dark">{finding.title}</div>
      <p className="mb-1.5 text-ink-light/90 dark:text-ink-dark/90">{finding.description}</p>
      <p className="mb-1.5 text-ink-light/80 dark:text-ink-dark/80">
        <span className="font-medium">Recommendation: </span>
        {finding.recommendation}
      </p>
      {suggestion && <MarkdownRenderer content={suggestion} tone="auto" />}
    </div>
  );
}
