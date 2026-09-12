import { Fragment, ReactNode } from "react";
import { cn } from "@/utils/cn";
import { CitationToken, resolveCitation, splitCitations } from "@/utils/citations";
import type { SourceRef, SourcesProvenance } from "@/types/sourceTypes";

interface CitationRenderOptions {
  sources: SourceRef[];
  provenance: SourcesProvenance | null | undefined;
  /** False while streaming: styled, but only clickable once the answer is saved. */
  interactive: boolean;
  onActivate?: (n: number) => void;
}

function describeSource(source: SourceRef | undefined): string | undefined {
  if (!source) return undefined;
  const name = source.filePath ?? source.title;
  const detail = source.symbol ?? source.section;
  return [name, detail].filter(Boolean).join(" · ") || undefined;
}

const CHIP =
  "relative -top-px inline-flex h-4 min-w-[1rem] items-center justify-center rounded px-1 font-mono text-[10px] font-medium leading-none bg-black/[.06] text-muted-light dark:bg-white/[.08] dark:text-muted-dark";

function CitationGroup({ token, options }: { token: CitationToken; options: CitationRenderOptions }) {
  const parts = resolveCitation(token, options.sources, options.provenance);

  // Nothing here points at a real source for this message: leave the
  // model's text as it was, just muted — never link it.
  if (parts.every((p) => p.n === null)) {
    return <span className="text-muted-light dark:text-muted-dark">{token.raw}</span>;
  }

  return (
    <span className="mx-0.5 inline-flex items-center gap-0.5 align-baseline">
      {parts.map((part, i) => {
        if (part.n === null) {
          return (
            <span key={i} className="text-[11px] text-muted-light dark:text-muted-dark">
              {part.label}
            </span>
          );
        }
        const n = part.n;
        const title = describeSource(options.sources.find((s) => s.n === n));
        if (!options.interactive || !options.onActivate) {
          return (
            <span key={i} className={CHIP} title={title}>
              {n}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => options.onActivate!(n)}
            title={title}
            aria-label={title ? `Source ${n}: ${title}` : `Source ${n}`}
            className={cn(
              CHIP,
              "cursor-pointer transition-colors hover:bg-signal-500/15 hover:text-signal-700 dark:hover:text-signal-300",
            )}
          >
            {n}
          </button>
        );
      })}
    </span>
  );
}

/** Renders a plain-text segment with its citations turned into source chips. */
export function renderWithCitations(text: string, options: CitationRenderOptions): ReactNode {
  const segments = splitCitations(text);
  if (segments.length === 1 && typeof segments[0] === "string") return text;
  return segments.map((segment, i) =>
    typeof segment === "string" ? (
      <Fragment key={i}>{segment}</Fragment>
    ) : (
      <CitationGroup key={i} token={segment} options={options} />
    ),
  );
}
