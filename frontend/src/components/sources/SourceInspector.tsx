import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { SourceItem } from "./SourceItem";
import type { SourceKind, SourceRef, SourcesProvenance } from "@/types/sourceTypes";

// Fixed display order. Numbers come from the prompt and aren't renumbered,
// so within a group they're sorted but may skip (e.g. Code: 4, 5; Docs: 3).
const GROUPS: { kind: SourceKind; label: string }[] = [
  { kind: "code", label: "Code" },
  { kind: "documentation", label: "Documentation" },
  { kind: "summary", label: "AI summary" },
  { kind: "imports", label: "Related code" },
];

interface SourceInspectorProps {
  id: string;
  /** Identifies the inspected message; the list remounts when it changes. */
  messageKey: string;
  sources: SourceRef[];
  provenance: SourcesProvenance | null | undefined;
  focusedN: number | null;
  /** Increments on each citation click — scrolls to and flashes the focused source. */
  flashToken: number;
  onFocus: (n: number | null) => void;
  onClose: () => void;
}

/**
 * Right-side inspector for one answer's sources. Docked beside the chat on
 * wide screens (resizable, width persisted like ReviewAIPanel), an overlay
 * drawer below the xl breakpoint so the chat layout isn't squeezed.
 */
export function SourceInspector({
  id,
  messageKey,
  sources,
  provenance,
  focusedN,
  flashToken,
  onFocus,
  onClose,
}: SourceInspectorProps) {
  const { width, handleProps } = useResizableWidth({
    storageKey: "source-inspector-width",
    defaultWidth: 420,
    minWidth: 360,
    maxWidth: 640,
  });
  const itemRefs = useRef(new Map<number, HTMLDivElement>());
  const [flashN, setFlashN] = useState<number | null>(null);

  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: sources.filter((s) => s.kind === g.kind).sort((a, b) => a.n - b.n),
      })).filter((g) => g.items.length > 0),
    [sources],
  );

  useEffect(() => {
    if (!flashToken || focusedN === null) return;
    itemRefs.current.get(focusedN)?.scrollIntoView({ block: "nearest" });
    setFlashN(focusedN);
    const timer = setTimeout(() => setFlashN(null), 1200);
    return () => clearTimeout(timer);
    // Only an explicit citation click (a new token) should scroll/flash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashToken]);

  return (
    <aside
      id={id}
      aria-label="Sources"
      style={{ "--inspector-w": `${width}px` } as React.CSSProperties}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(100%,480px)] flex-col border-l border-border-light bg-surface-light shadow-panel dark:border-border-dark dark:bg-surface-dark xl:relative xl:inset-auto xl:z-auto xl:w-[var(--inspector-w)] xl:shrink-0 xl:shadow-none"
    >
      <button
        type="button"
        aria-label="Resize sources panel"
        {...handleProps}
        className="absolute -left-1 top-0 z-10 hidden h-full w-2 cursor-col-resize touch-none focus:outline-none focus-visible:bg-signal-500/40 xl:block"
      />

      <div className="flex shrink-0 items-center gap-2 border-b border-border-light px-3 py-2.5 dark:border-border-dark">
        <h2 className="font-sans text-sm font-medium tracking-normal text-ink-light dark:text-ink-dark">
          Sources <span className="text-muted-light dark:text-muted-dark">· {sources.length}</span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close sources"
          className="ml-auto shrink-0 rounded p-1 text-muted-light hover:bg-black/[.03] hover:text-ink-light dark:text-muted-dark dark:hover:bg-white/[.04] dark:hover:text-ink-dark"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {provenance === "legacy" && (
        <p className="shrink-0 border-b border-border-light px-3 py-2 text-[11px] text-muted-light dark:border-border-dark dark:text-muted-dark">
          Saved before exact source tracking — this list may include context the AI didn't see, and
          excerpts may differ from what it was shown.
        </p>
      )}

      <div key={messageKey} className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {groups.map((group) => (
          <section key={group.kind}>
            <h3 className="px-2 pb-1 pt-3 font-sans text-[11px] font-semibold uppercase tracking-wider text-muted-light dark:text-muted-dark">
              {group.label}
            </h3>
            {group.items.map((source) => (
              <SourceItem
                key={source.n}
                source={source}
                expanded={focusedN === source.n}
                flashing={flashN === source.n}
                onToggle={() => onFocus(focusedN === source.n ? null : source.n)}
                itemRef={(el) => {
                  if (el) itemRefs.current.set(source.n, el);
                  else itemRefs.current.delete(source.n);
                }}
              />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
