import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Lock,
  Globe,
  LayoutGrid,
  Terminal,
  PlayCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { LocalRepository } from "@/types/repositoryTypes";
import { useRepositorySyncStatus } from "@/hooks/useRepository";

interface RepositoryWorkspaceBarProps {
  repo: LocalRepository;
  repositoryId: string;
  mode: "QA" | "INTERVIEW";
}

/**
 * Compact top bar for the full-screen chat/interview workspaces — replaces
 * RepositoryHeader + RepositorySubNav on those two routes only, so the
 * conversation gets the vertical space instead of a tall identity block.
 * Overview/Pulls keep the full header untouched.
 */
export function RepositoryWorkspaceBar({ repo, repositoryId, mode }: RepositoryWorkspaceBarProps) {
  const base = `/repositories/${repositoryId}`;
  const inWorkspace = !!repo.workspace_started_at;
  const { data: syncStatus } = useRepositorySyncStatus(repo.id, inWorkspace);

  const navItems = [
    { label: "Overview", to: base, icon: LayoutGrid, active: false },
    { label: "Codebase Q&A", to: `${base}/chat`, icon: Terminal, active: mode === "QA" },
    { label: "Interview", to: `${base}/interview`, icon: PlayCircle, active: mode === "INTERVIEW" },
  ];

  const statusDisplay = (() => {
    if (!inWorkspace || !syncStatus) {
      return { dot: "bg-slate-300 dark:bg-slate-600", label: "Not started" };
    }
    switch (syncStatus.status) {
      case "READY":
        return { dot: "bg-emerald-500", label: "Indexed" };
      case "SYNCING":
      case "INDEXING":
        return { dot: null, label: "Indexing…", spinning: true };
      case "FAILED":
        return { dot: "bg-rose-500", label: "Failed" };
      default:
        return { dot: "bg-slate-300 dark:bg-slate-600", label: "Not started" };
    }
  })();

  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border-light dark:border-border-dark">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to={base}
          className="flex shrink-0 items-center gap-1.5 text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
          title="Back to Overview"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {repo.is_private ? (
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-light dark:text-muted-dark" />
        ) : (
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-light dark:text-muted-dark" />
        )}
        <span className="hidden truncate text-sm font-medium text-ink-light dark:text-ink-dark sm:inline">
          {repo.owner}/{repo.name}
        </span>
        <span className="shrink-0 text-sm text-muted-light dark:text-muted-dark">/</span>
        <span className="truncate text-sm font-medium text-ink-light dark:text-ink-dark">
          {mode === "QA" ? "Codebase Q&A" : "Technical Interview"}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {navItems.map(({ label, to, icon: Icon, active }) => (
          <Link
            key={to}
            to={to}
            title={label}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
              active
                ? "bg-signal-100 text-signal-700 dark:bg-signal-500/10 dark:text-signal-300"
                : "text-muted-light hover:bg-black/[.03] hover:text-ink-light dark:text-muted-dark dark:hover:bg-white/[.04] dark:hover:text-ink-dark",
            )}
          >
            <Icon className="h-4 w-4" />
          </Link>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-light dark:text-muted-dark">
        {statusDisplay.spinning ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <span className={cn("h-1.5 w-1.5 rounded-full", statusDisplay.dot)} />
        )}
        <span className="hidden md:inline">{statusDisplay.label}</span>
      </div>
    </div>
  );
}
