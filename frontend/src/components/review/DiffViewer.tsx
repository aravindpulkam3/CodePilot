import { CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { parseDiff, DiffHunk, DiffLine } from "@/utils/parseDiff";
import { languageForFilename, highlightLine } from "@/utils/prismLang";
import { ChangedFile, Finding, severityRank } from "@/types/reviewTypes";
import { basename, dirname } from "@/utils/reviewNavigation";
import { useElementWidth } from "@/hooks/useElementWidth";
import { FindingAnnotation } from "./FindingAnnotation";
import { SeverityIcon } from "./SeverityIcon";

interface DiffViewerProps {
  file: ChangedFile;
  /** This file's findings, in reading order (file-level first, then by line). */
  findings: Finding[];
  activeFindingId: string | null;
  discussionFindingId: string | null;
  onSelectFinding: (finding: Finding) => void;
  onDiscuss: (finding: Finding) => void;
  fileIndex: number;
  fileCount: number;
  onStepFile: (delta: 1 | -1) => void;
  /** Where to send people for a diff GitHub didn't include (binary/huge files). */
  githubFilesUrl: string | null;
  compact: boolean;
}

// decoration · old line · new line · marker · code
const GRID: CSSProperties = { gridTemplateColumns: "16px 44px 44px 16px minmax(0, 1fr)" };
// Rendering every hunk of a very large diff is the slow part; past this many,
// let the browser skip off-screen hunks.
const LAZY_HUNK_THRESHOLD = 40;

const worstOf = (list: Finding[]) =>
  list.reduce((acc, f) => (severityRank(f.severity) < severityRank(acc.severity) ? f : acc));

/**
 * One file's diff as the workspace's primary surface. Findings hang under
 * the new-side line they cite, marked in the gutter by their severity glyph;
 * findings with no line that is actually in the diff (or on files GitHub
 * sends no patch for) sit at the top as file-level comments.
 */
export function DiffViewer({
  file,
  findings,
  activeFindingId,
  discussionFindingId,
  onSelectFinding,
  onDiscuss,
  fileIndex,
  fileCount,
  onStepFile,
  githubFilesUrl,
  compact,
}: DiffViewerProps) {
  const hunks = useMemo(() => parseDiff(file.patch), [file.patch]);
  const language = useMemo(() => languageForFilename(file.filename), [file.filename]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The diff scrolls horizontally for long lines; comments are pinned to the
  // visible width (sticky, sized to the viewport) so they never run off-screen.
  const { ref: viewportRef, width: viewportWidth } = useElementWidth<HTMLDivElement>();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const lineRefs = useRef(new Map<number, HTMLDivElement>());
  const fileLevelRef = useRef<HTMLDivElement>(null);

  // line_number is an unvalidated model guess on the new side, so only lines
  // actually rendered as added/context can anchor a finding.
  const { findingsByLine, fileLevel } = useMemo(() => {
    const rendered = new Set<number>();
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if ((line.type === "add" || line.type === "context") && line.newLine !== null) rendered.add(line.newLine);
      }
    }
    const byLine = new Map<number, Finding[]>();
    const fileLevel: Finding[] = [];
    for (const finding of findings) {
      if (finding.line_number !== null && rendered.has(finding.line_number)) {
        byLine.set(finding.line_number, [...(byLine.get(finding.line_number) ?? []), finding]);
      } else {
        fileLevel.push(finding);
      }
    }
    return { findingsByLine: byLine, fileLevel };
  }, [hunks, findings]);

  const activeFinding = findings.find((f) => f.id === activeFindingId) ?? null;
  const activeLine =
    activeFinding && activeFinding.line_number !== null && findingsByLine.has(activeFinding.line_number)
      ? activeFinding.line_number
      : null;

  // Scroll vertically only: scrollIntoView would also scroll sideways to the
  // (often wider-than-the-pane) code cell and hide the line-number gutters.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!activeFinding || !scroller) return;
    const target = activeLine !== null ? lineRefs.current.get(activeLine) : fileLevelRef.current;
    if (!target) return;
    const box = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const offset = rect.top - box.top;
    scroller.scrollTop += activeLine !== null ? offset - (box.height - rect.height) / 2 : offset;
    // Only a change of active finding should move the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFindingId]);

  const isCollapsed = (id: string) => id !== activeFindingId && collapsed.has(id);
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allCollapsed = findings.length > 0 && findings.every((f) => collapsed.has(f.id));

  const activeIndex = findings.findIndex((f) => f.id === activeFindingId);
  const stepFinding = (delta: 1 | -1) => {
    const next = activeIndex < 0 ? (delta === 1 ? 0 : findings.length - 1) : activeIndex + delta;
    if (next >= 0 && next < findings.length) onSelectFinding(findings[next]);
  };

  const annotation = (finding: Finding) => (
    <FindingAnnotation
      key={finding.id}
      finding={finding}
      filePath={file.filename}
      active={finding.id === activeFindingId}
      inDiscussion={finding.id === discussionFindingId}
      collapsed={isCollapsed(finding.id)}
      onToggleCollapsed={() => toggleCollapsed(finding.id)}
      onSelect={() => onSelectFinding(finding)}
      onDiscuss={() => onDiscuss(finding)}
    />
  );

  const stepButton = "flex h-6 w-6 items-center justify-center rounded text-rv-mute hover:bg-rv-hover hover:text-rv-ink disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <section aria-label={`Diff of ${file.filename}`} className="flex min-h-0 min-w-0 flex-1 flex-col bg-rv-code">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-rv-hair pl-4 pr-2">
        <span
          className="rv-truncate-start min-w-0 font-mono text-xs text-rv-mute"
          title={file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename}
        >
          <span>
            {dirname(file.filename)}
            <b className="font-semibold text-rv-ink">{basename(file.filename)}</b>
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-rv-mute">
          +{file.additions} −{file.deletions}
          {file.previous_filename && " · renamed"}
        </span>

        <div className="ml-auto flex shrink-0 items-center text-xs">
          {findings.length > 0 && (
            <>
              <span className="flex items-center">
                {!compact && <span className="mr-1 text-rv-mute">Finding</span>}
                <button type="button" aria-label="Previous finding in file" onClick={() => stepFinding(-1)} disabled={activeIndex === 0} className={stepButton}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[44px] text-center font-mono text-[11px] text-rv-ink2">
                  {activeIndex >= 0 ? activeIndex + 1 : "–"} of {findings.length}
                </span>
                <button
                  type="button"
                  aria-label="Next finding in file"
                  onClick={() => stepFinding(1)}
                  disabled={activeIndex === findings.length - 1}
                  className={stepButton}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </span>
              <span className="mx-2 h-4 w-px bg-rv-hair" />
            </>
          )}
          <span className="flex items-center">
            {!compact && <span className="mr-1 text-rv-mute">File</span>}
            <button type="button" aria-label="Previous file" onClick={() => onStepFile(-1)} disabled={fileIndex <= 0} className={stepButton}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[44px] text-center font-mono text-[11px] text-rv-ink2">
              {fileIndex + 1} of {fileCount}
            </span>
            <button type="button" aria-label="Next file" onClick={() => onStepFile(1)} disabled={fileIndex >= fileCount - 1} className={stepButton}>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
          {findings.length > 0 && !compact && (
            <>
              <span className="mx-2 h-4 w-px bg-rv-hair" />
              <button
                type="button"
                onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(findings.map((f) => f.id)))}
                className="inline-flex h-[26px] items-center rounded px-2 text-rv-ink2 hover:bg-rv-hover hover:text-rv-ink"
              >
                {allCollapsed ? "Expand all" : "Collapse all"}
              </button>
            </>
          )}
        </div>
      </div>

      <div
        ref={(el) => {
          scrollerRef.current = el;
          viewportRef(el);
        }}
        className="thin-scrollbar min-h-0 flex-1 overflow-auto"
      >
        {(fileLevel.length > 0 || !file.patch) && (
          <div ref={fileLevelRef} className="grid grid-cols-[120px_minmax(0,1fr)] items-start border-b border-rv-hair py-2.5 pr-4">
            <span className="pr-4 pt-1.5 text-right text-[11px] text-rv-mute">File</span>
            <div className="flex min-w-0 flex-col gap-1.5">
              {!file.patch && (
                <p className="py-1 text-[13px] text-rv-mute">
                  Diff not shown — GitHub returns no patch for binary or very large files.
                  {githubFilesUrl && (
                    <>
                      {" "}
                      <a href={githubFilesUrl} target="_blank" rel="noreferrer" className="text-rv-ink2 underline-offset-2 hover:underline">
                        View on GitHub
                      </a>
                    </>
                  )}
                </p>
              )}
              {fileLevel.map(annotation)}
            </div>
          </div>
        )}

        <div
          className="w-max min-w-full"
          style={{ "--diff-viewport": viewportWidth ? `${viewportWidth}px` : "100%" } as CSSProperties}
        >
          {hunks.map((hunk, i) => (
            <Hunk
              key={i}
              hunk={hunk}
              language={language}
              lazy={hunks.length > LAZY_HUNK_THRESHOLD}
              findingsByLine={findingsByLine}
              activeLine={activeLine}
              renderAnnotation={annotation}
              registerLine={(line, el) => {
                if (el) lineRefs.current.set(line, el);
                else lineRefs.current.delete(line);
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Hunk({
  hunk,
  language,
  lazy,
  findingsByLine,
  activeLine,
  renderAnnotation,
  registerLine,
}: {
  hunk: DiffHunk;
  language: string;
  lazy: boolean;
  findingsByLine: Map<number, Finding[]>;
  activeLine: number | null;
  renderAnnotation: (finding: Finding) => JSX.Element;
  registerLine: (line: number, el: HTMLDivElement | null) => void;
}) {
  const header = hunk.header.match(/^(@@[^@]*@@)\s*(.*)$/);
  return (
    <div
      className="prism-code grid font-mono text-[12.5px] leading-5 [font-variant-ligatures:none]"
      style={lazy ? { ...GRID, contentVisibility: "auto", containIntrinsicSize: "auto 400px" } : GRID}
    >
      <div className="col-span-full flex h-7 items-center gap-3 overflow-hidden whitespace-nowrap border-y border-rv-hair bg-rv-rec pl-[76px] pr-4 text-[11.5px] text-rv-mute">
        <span>{header ? header[1] : hunk.header}</span>
        {header?.[2] && <span className="truncate text-rv-ink2">{header[2]}</span>}
      </div>
      {hunk.lines.map((line, i) => {
        const lineFindings = line.newLine !== null ? findingsByLine.get(line.newLine) : undefined;
        return (
          <Fragment key={i}>
            <Row
              line={line}
              language={language}
              flag={lineFindings ? worstOf(lineFindings) : null}
              active={line.newLine !== null && line.newLine === activeLine}
              registerLine={registerLine}
            />
            {lineFindings && (
              <div className="sticky left-0 col-span-full flex w-[var(--diff-viewport)] flex-col gap-1.5 justify-self-start pb-3 pl-[120px] pr-4 pt-1.5 font-sans text-[13px] [font-variant-ligatures:normal]">
                {lineFindings.map(renderAnnotation)}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function Row({
  line,
  language,
  flag,
  active,
  registerLine,
}: {
  line: DiffLine;
  language: string;
  flag: Finding | null;
  active: boolean;
  registerLine: (line: number, el: HTMLDivElement | null) => void;
}) {
  if (line.type === "meta") {
    return <div className="col-span-2 col-start-4 h-5 px-2 text-[11px] italic text-rv-mute">{line.content}</div>;
  }

  const body = line.type === "add" ? "bg-rv-add" : line.type === "del" ? "bg-rv-del" : "";
  const gutter = line.type === "add" ? "bg-rv-addg" : line.type === "del" ? "bg-rv-delg" : "";
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : "";
  const markerColor = line.type === "add" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const highlight = active && "rv-active-line";

  return (
    <>
      <div className={cn("relative h-5", gutter, highlight)}>
        {flag && <SeverityIcon severity={flag.severity} className="absolute left-[3px] top-1" />}
      </div>
      <div className={cn("h-5 select-none pr-2.5 text-right text-[11px] text-rv-lnc", gutter, highlight)}>{line.oldLine ?? ""}</div>
      <div className={cn("h-5 select-none pr-2.5 text-right text-[11px] text-rv-lnc", gutter, highlight)}>{line.newLine ?? ""}</div>
      <div className={cn("h-5 select-none text-center", gutter, markerColor, highlight)}>{marker}</div>
      {/* The ref sits on a real cell (rows are display:contents-free grid
          items), so scrollIntoView always has geometry to work with. */}
      <div
        ref={line.newLine !== null ? (el) => registerLine(line.newLine!, el) : undefined}
        className={cn("h-5 whitespace-pre pr-4 text-rv-ink", body, highlight, active && "rv-active-code")}
        dangerouslySetInnerHTML={{ __html: highlightLine(line.content || " ", language) }}
      />
    </>
  );
}
