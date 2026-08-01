import { Link } from "react-router-dom";
import { Terminal, GitBranch, FileCode2, ArrowRight } from "lucide-react";
import { ROUTES } from "@/constants/routes";
import { Button } from "@/components/ui/Button";

/**
 * Signature element: a static "reading a codebase" panel — a file tree
 * resolving into an annotated explanation — since that's the one thing
 * this product does that a generic SaaS landing page doesn't need to
 * gesture at. No animation beyond a single on-load fade; the panel's
 * content is illustrative, not a working demo.
 */
export default function Landing() {
  return (
    <div className="min-h-screen bg-canvas-light dark:bg-canvas-dark">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-signal-600 text-white">
            <Terminal size={16} strokeWidth={2.5} />
          </div>
          <span className="font-display text-sm font-semibold text-ink-light dark:text-ink-dark">
            AI Engineering Workspace
          </span>
        </div>
        <nav className="flex items-center gap-2">
          <Link to={ROUTES.login}>
            <Button variant="ghost" size="sm">
              Sign in
            </Button>
          </Link>
          <Link to={ROUTES.signup}>
            <Button size="sm">Get started</Button>
          </Link>
        </nav>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-14 px-6 pb-24 pt-10 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
        <div className="animate-[fadein_0.5s_ease-out]">
          <p className="mb-4 font-mono text-xs uppercase tracking-wider text-signal-600">
            for teams shipping on unfamiliar code
          </p>
          <h1 className="text-4xl font-bold leading-[1.1] text-ink-light dark:text-ink-dark sm:text-5xl">
            Understand any codebase before you change a line of it.
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-light dark:text-muted-dark">
            Connect a repository and get answers grounded in the actual code — architecture,
            history, and intent — instead of guessing from filenames.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to={ROUTES.signup}>
              <Button size="lg" className="group">
                Create your workspace
                <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
              </Button>
            </Link>
            <Link to={ROUTES.login}>
              <Button variant="secondary" size="lg">
                Sign in
              </Button>
            </Link>
          </div>
          <p className="mt-6 font-mono text-xs text-muted-light dark:text-muted-dark">
            Auth via email or <span className="text-ink-light dark:text-ink-dark">GitHub</span> — no
            credit card.
          </p>
        </div>

        {/* Signature panel */}
        <div className="animate-[fadein_0.6s_ease-out] rounded-lg border border-border-light bg-surface-light shadow-panel dark:border-border-dark dark:bg-surface-dark">
          <div className="flex items-center gap-1.5 border-b border-border-light px-4 py-3 dark:border-border-dark">
            <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-signal-500/70" />
            <span className="ml-2 font-mono text-xs text-muted-light dark:text-muted-dark">
              payments-service/
            </span>
          </div>
          <div className="grid grid-cols-[120px_1fr] divide-x divide-border-light text-xs dark:divide-border-dark">
            <div className="space-y-1.5 p-4 font-mono text-muted-light dark:text-muted-dark">
              <div className="flex items-center gap-1.5">
                <GitBranch size={12} /> main
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-ink-light dark:text-ink-dark">
                <FileCode2 size={12} /> refunds.ts
              </div>
              <div className="pl-4 text-muted-light/70 dark:text-muted-dark/70">webhook.ts</div>
              <div className="pl-4 text-muted-light/70 dark:text-muted-dark/70">ledger.ts</div>
              <div className="pl-4 text-muted-light/70 dark:text-muted-dark/70">retry.ts</div>
            </div>
            <div className="space-y-2.5 p-4">
              <p className="font-mono text-[11px] text-muted-light dark:text-muted-dark">
                refunds.ts · lines 42–58
              </p>
              <p className="leading-relaxed text-ink-light dark:text-ink-dark">
                Partial refunds are reconciled against <code className="rounded bg-signal-500/10 px-1 font-mono text-signal-700 dark:text-signal-300">ledger.ts</code> before the webhook fires — this is why refund totals lag the UI by one cycle.
              </p>
              <div className="h-px w-full bg-border-light dark:bg-border-dark" />
              <p className="font-mono text-[11px] text-muted-light dark:text-muted-dark">3 related call sites</p>
            </div>
          </div>
        </div>
      </main>

      <style>{`
        @keyframes fadein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}
