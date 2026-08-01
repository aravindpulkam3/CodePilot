import { cn } from "@/utils/cn";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "signal" | "amber";
}) {
  const tones = {
    neutral:
      "bg-black/[.04] text-muted-light dark:bg-white/[.06] dark:text-muted-dark",
    signal: "bg-signal-100 text-signal-700 dark:bg-signal-500/10 dark:text-signal-300",
    amber: "bg-amber-400/10 text-amber-400",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-mono font-medium",
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}
