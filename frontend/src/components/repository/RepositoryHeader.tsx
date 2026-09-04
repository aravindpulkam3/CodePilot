import { Link } from "react-router-dom";
import { Lock, Globe, GitBranch, ArrowLeft, ExternalLink, Clock, Rocket, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { LocalRepository } from "@/types/repositoryTypes";
import { useRepositorySyncStatus, useStartWorking } from "@/hooks/useRepository";

/**
 * Compact repository identity bar. Replaces the old stacked
 * PageHeader + 4-cell metadata Card with a single row — the repo header
 * is context the user scans once, not content, so it shouldn't compete
 * with the actual workspace below it for vertical space.
 */
export function RepositoryHeader({ repo }: { repo: LocalRepository }) {
  const inWorkspace = !!repo.workspace_started_at;
  const { data: syncStatus } = useRepositorySyncStatus(repo.id, inWorkspace);
  const startWorking = useStartWorking(repo.id);

  return (
    <div className="shrink-0 border-b border-border-light dark:border-border-dark pb-4">
      <Link
        to="/repositories"
        className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Repositories
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {repo.is_private ? (
              <Lock className="h-4 w-4 shrink-0 text-muted-light dark:text-muted-dark" />
            ) : (
              <Globe className="h-4 w-4 shrink-0 text-muted-light dark:text-muted-dark" />
            )}
            <h1 className="truncate text-xl font-semibold text-ink-light dark:text-ink-dark">
              {repo.name}
            </h1>
            <a
              href={repo.html_url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
              title="Open on GitHub"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          {repo.description && (
            <p className="mt-1 max-w-2xl truncate text-sm text-muted-light dark:text-muted-dark">
              {repo.description}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-light dark:text-muted-dark">
          {repo.language && <Badge tone="neutral">{repo.language}</Badge>}
          <span className="flex items-center gap-1">
            <GitBranch className="h-3.5 w-3.5" />
            {repo.default_branch}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {repo.last_pushed_at
              ? `Pushed ${new Date(repo.last_pushed_at).toLocaleDateString()}`
              : "No pushes yet"}
          </span>
        </div>
      </div>

      {!inWorkspace ? (
        <div className="mt-3 flex items-center justify-between rounded-lg bg-indigo-50 px-4 py-2.5 dark:bg-indigo-500/10">
          <p className="text-sm text-indigo-700 dark:text-indigo-300">
            Q&amp;A, Review, and Interview need this repo indexed first.
          </p>
          <button
            onClick={() => startWorking.mutate()}
            disabled={startWorking.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            <Rocket className="h-3.5 w-3.5" />
            {startWorking.isPending ? "Starting…" : "Start Working on This Repo"}
          </button>
        </div>
      ) : syncStatus && syncStatus.status !== "READY" ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-4 py-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-400">
          {syncStatus.status === "FAILED" ? (
            <span className="text-rose-600 dark:text-rose-400">
              Indexing failed — try syncing again.
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {syncStatus.status === "SYNCING" || syncStatus.status === "INDEXING"
                  ? "Indexing…"
                  : "Searchable — summarizing in background…"}
              </span>
              {syncStatus.indexProgress?.filesTotal ? (
                <span>
                  Files {syncStatus.indexProgress.filesDone}/{syncStatus.indexProgress.filesTotal}
                </span>
              ) : null}
              {syncStatus.summaryProgress?.tasksTotal ? (
                <span>
                  Summaries {syncStatus.summaryProgress.tasksDone}/{syncStatus.summaryProgress.tasksTotal}
                </span>
              ) : null}
              {syncStatus.status === "SEARCHABLE" || syncStatus.status === "SUMMARIZING" ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  Q&amp;A/Review/Interview available now
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
