import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/utils/cn";
import { Finding, severityLabel } from "@/types/reviewTypes";
import { stripCodeFence } from "@/utils/reviewNavigation";
import { CodeExcerpt } from "@/components/sources/CodeExcerpt";
import { SeverityIcon } from "./SeverityIcon";

interface FindingAnnotationProps {
  finding: Finding;
  /** The file the finding belongs to — picks the suggestion's highlighter. */
  filePath: string;
  active: boolean;
  inDiscussion: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: () => void;
  onDiscuss: () => void;
}

/** Renders `code` spans inside the model's prose; everything else stays plain text. */
export function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="rounded-sm bg-rv-rec px-1 py-px font-mono text-[12px] text-rv-ink">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * One review finding, hanging directly under the line it is about. It reads
 * as a code review comment: neutral raised surface, severity only in the
 * glyph (the same glyph marks the line in the gutter), the recommendation
 * set apart, and the suggested change rendered like the diff itself.
 */
export function FindingAnnotation({
  finding,
  filePath,
  active,
  inDiscussion,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onDiscuss,
}: FindingAnnotationProps) {
  const [copied, setCopied] = useState(false);
  const suggestion = finding.code_suggestion ? stripCodeFence(finding.code_suggestion) : null;
  const where = finding.line_number !== null ? `line ${finding.line_number}` : "file-level";

  const copyFix = () => {
    if (!suggestion) return;
    navigator.clipboard.writeText(suggestion).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => {
          onToggleCollapsed();
          onSelect();
        }}
        className="flex h-[30px] w-full max-w-[760px] items-center gap-2 rounded border border-rv-bd bg-rv-raised pl-3 pr-2 text-left text-xs text-rv-mute hover:border-rv-lnc"
      >
        <SeverityIcon severity={finding.severity} />
        <span className="min-w-0 truncate text-[13px] text-rv-ink">{finding.title}</span>
        <span className="shrink-0">
          · {finding.category} · {where}
        </span>
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" />
      </button>
    );
  }

  const textButton = "inline-flex h-[26px] items-center rounded px-2 text-xs text-rv-ink2 hover:bg-rv-hover hover:text-rv-ink";

  return (
    <article
      aria-label={`${severityLabel(finding.severity)}: ${finding.title}`}
      onClick={onSelect}
      className={cn(
        "w-full max-w-[760px] rounded border bg-rv-raised",
        active ? "border-rv-tealbd" : "border-rv-bd",
      )}
    >
      <header className="flex h-8 items-center gap-2 pl-3 pr-1.5 text-xs text-rv-mute">
        <SeverityIcon severity={finding.severity} />
        <span className="font-semibold text-rv-ink2">{severityLabel(finding.severity)}</span>
        <span className="truncate">
          {finding.category} · {where}
        </span>
        {inDiscussion && <span className="shrink-0 text-[11px] text-rv-teal">· In discussion</span>}
        <span className="ml-auto flex shrink-0 items-center">
          {!inDiscussion && (
            <button
              type="button"
              className={textButton}
              onClick={(e) => {
                e.stopPropagation();
                onDiscuss();
              }}
            >
              Discuss
            </button>
          )}
          {suggestion && (
            <button
              type="button"
              className={textButton}
              onClick={(e) => {
                e.stopPropagation();
                copyFix();
              }}
            >
              {copied ? "Copied" : "Copy fix"}
            </button>
          )}
          <button
            type="button"
            aria-label="Collapse finding"
            className="flex h-6 w-6 items-center justify-center rounded text-rv-mute hover:bg-rv-hover hover:text-rv-ink"
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapsed();
            }}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        </span>
      </header>

      <div className="px-3 pb-3 text-[13px] leading-5">
        <h3 className="mb-1 font-sans text-[13px] font-semibold tracking-normal text-rv-ink">{finding.title}</h3>
        <p className="text-rv-ink2">
          <InlineCode text={finding.description} />
        </p>

        {finding.recommendation && (
          <>
            <div className="mb-2 mt-2.5 h-px bg-rv-hair" />
            <h4 className="mb-0.5 font-sans text-xs font-semibold tracking-normal text-rv-ink">Recommendation</h4>
            <p className="text-rv-ink2">
              <InlineCode text={finding.recommendation} />
            </p>
          </>
        )}

        {suggestion && (
          <>
            <div className="mb-1.5 mt-2.5 flex items-center">
              <h4 className="font-sans text-xs font-semibold tracking-normal text-rv-ink">Suggested change</h4>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyFix();
                }}
                className="ml-auto text-xs text-rv-mute hover:text-rv-ink"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <CodeExcerpt
              code={suggestion}
              filePath={filePath}
              className="overflow-hidden rounded border border-rv-hair bg-rv-code"
            />
          </>
        )}
      </div>
    </article>
  );
}
