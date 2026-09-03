import { AlertCircle, RefreshCw } from "lucide-react";

/**
 * Shared inline "this failed to load" panel. Use instead of letting a
 * failed fetch fall through to an empty-state message ("No X found") —
 * that reads as "there's nothing here" when the real story is "the
 * request failed," which is misleading.
 */
export function ErrorState({
  message = "Something went wrong loading this.",
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-rose-300 bg-rose-50/60 py-10 text-center dark:border-rose-900/60 dark:bg-rose-950/20 ${className ?? ""}`}
    >
      <AlertCircle className="h-6 w-6 text-rose-500" />
      <p className="text-sm font-medium text-rose-700 dark:text-rose-400">
        {message}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-300"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </button>
      )}
    </div>
  );
}
