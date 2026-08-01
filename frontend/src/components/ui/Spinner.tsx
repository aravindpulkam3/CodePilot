export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

export function FullScreenSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-3 bg-canvas-light dark:bg-canvas-dark">
      <Spinner className="h-6 w-6 text-signal-600" />
      <p className="text-sm text-muted-light dark:text-muted-dark">{label}</p>
    </div>
  );
}
