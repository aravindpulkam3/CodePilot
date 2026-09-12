import { Fragment, useMemo, useState } from "react";
import { highlightLine, languageForFilename } from "@/utils/prismLang";

const PREVIEW_LINES = 12;

interface CodeExcerptProps {
  code: string;
  filePath?: string;
  /** File line of the first excerpt line. No gutter when absent (lines aren't file-aligned). */
  startLine?: number;
}

/**
 * The stored, AI-visible excerpt with Prism highlighting and a line gutter —
 * same highlighter and `.prism-code` token theme as DiffViewer. Not a file
 * viewer: it shows exactly the snapshot, nothing fetched.
 */
export function CodeExcerpt({ code, filePath, startLine }: CodeExcerptProps) {
  const lines = useMemo(() => code.split("\n"), [code]);
  const language = useMemo(() => languageForFilename(filePath ?? ""), [filePath]);
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? lines : lines.slice(0, PREVIEW_LINES);
  const hasMore = lines.length > PREVIEW_LINES;

  return (
    <div className="overflow-hidden rounded-md border border-border-light dark:border-border-dark">
      <div className="thin-scrollbar overflow-x-auto">
        <div
          className="prism-code w-max min-w-full py-1.5 font-mono text-xs leading-5"
          style={{ display: "grid", gridTemplateColumns: startLine !== undefined ? "auto 1fr" : "1fr" }}
        >
          {visible.map((line, i) => (
            <Fragment key={i}>
              {startLine !== undefined && (
                <div className="select-none pl-2 pr-3 text-right text-muted-light dark:text-muted-dark">
                  {startLine + i}
                </div>
              )}
              <div
                className="whitespace-pre pl-2 pr-3"
                dangerouslySetInnerHTML={{ __html: highlightLine(line || " ", language) }}
              />
            </Fragment>
          ))}
        </div>
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="w-full border-t border-border-light px-2 py-1 text-left text-[11px] text-muted-light hover:text-ink-light dark:border-border-dark dark:text-muted-dark dark:hover:text-ink-dark"
        >
          {showAll ? "Show fewer lines" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
