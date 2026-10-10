import { cn } from "@/utils/cn";
import { severityKey, severityLabel } from "@/types/reviewTypes";

const COLOR = {
  critical: "text-rv-crit",
  major: "text-rv-major",
  minor: "text-rv-minor",
  info: "text-rv-info",
} as const;

/**
 * Severity as shape + color, so it survives color blindness and grayscale:
 * filled diamond (Critical), outlined triangle (Major), small dot (Minor),
 * outlined "i" (Info). `calm` mutes Minor/Info so dense lists only draw the
 * eye to what matters.
 */
export function SeverityIcon({
  severity,
  calm = false,
  className,
}: {
  severity: string | null | undefined;
  calm?: boolean;
  className?: string;
}) {
  const key = severityKey(severity);
  const color = calm && (key === "minor" || key === "info") ? "text-rv-mute" : COLOR[key];

  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={severityLabel(severity)}
      className={cn("h-3 w-3 shrink-0", color, className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {key === "critical" && <path d="M12 3 21 12 12 21 3 12z" fill="currentColor" stroke="none" />}
      {key === "major" && (
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4M12 17h.01" />
        </>
      )}
      {key === "minor" && <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />}
      {key === "info" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 16v-4M12 8h.01" />
        </>
      )}
    </svg>
  );
}
