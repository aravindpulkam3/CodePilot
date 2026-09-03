import { Link } from "react-router-dom";
import { Lock, Globe, GitBranch, ArrowLeft, ExternalLink, Clock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { LocalRepository } from "@/types/repositoryTypes";

/**
 * Compact repository identity bar. Replaces the old stacked
 * PageHeader + 4-cell metadata Card with a single row — the repo header
 * is context the user scans once, not content, so it shouldn't compete
 * with the actual workspace below it for vertical space.
 */
export function RepositoryHeader({ repo }: { repo: LocalRepository }) {
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
    </div>
  );
}
