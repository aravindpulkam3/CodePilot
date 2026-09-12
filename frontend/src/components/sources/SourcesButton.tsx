import { Layers } from "lucide-react";
import { cn } from "@/utils/cn";

interface SourcesButtonProps {
  count: number;
  active: boolean;
  controlsId: string;
  onClick: () => void;
}

/** The only permanent sources affordance on an answer — collapsed by default. */
export function SourcesButton({ count, active, controlsId, onClick }: SourcesButtonProps) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      aria-controls={controlsId}
      className={cn(
        "-ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors",
        active
          ? "bg-signal-500/10 text-signal-700 dark:text-signal-300"
          : "text-muted-light hover:bg-black/[.03] hover:text-ink-light dark:text-muted-dark dark:hover:bg-white/[.04] dark:hover:text-ink-dark",
      )}
    >
      <Layers className="h-3.5 w-3.5" />
      Sources ({count})
    </button>
  );
}
