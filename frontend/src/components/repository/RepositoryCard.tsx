import { Link } from "react-router-dom";
import {
  Lock,
  Globe,
  GitBranch,
  Clock,
  FileCode2,
  GitPullRequest,
  MessageSquare,
  PlayCircle,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { GitHubRepository } from "@/types/githubTypes";

const LANGUAGE_DOT: Record<string, string> = {
  TypeScript: "bg-blue-500",
  JavaScript: "bg-yellow-400",
  Python: "bg-green-500",
  Java: "bg-orange-500",
};

/**
 * Shared repo card used by both the Dashboard grid and the full
 * Repositories page, so there's one visual language for "a repository"
 * instead of two. Carries indexing status + source (connected/imported)
 * since those are the details that actually distinguish repos here.
 */
export function RepositoryCard({ repo }: { repo: GitHubRepository }) {
  return (
    <div className="group relative flex flex-col rounded-xl border border-slate-200/80 bg-white p-5 transition-all hover:border-slate-300 hover:shadow-sm dark:border-slate-800/80 dark:bg-slate-900 overflow-hidden">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-2 overflow-hidden">
          {repo.is_private ? (
            <Lock className="h-4 w-4 text-slate-400 shrink-0" />
          ) : (
            <Globe className="h-4 w-4 text-slate-400 shrink-0" />
          )}
          <h3 className="truncate font-medium text-slate-900 dark:text-white transition-colors">
            {repo.name}
          </h3>
        </div>

        {repo.indexing_status === "FAILED" ? (
          <span className="shrink-0 inline-flex items-center rounded-full bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/20">
            Failed
          </span>
        ) : repo.indexing_status === "INDEXING" ||
          repo.indexing_status === "PENDING" ? (
          <span className="shrink-0 inline-flex items-center rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20">
            {repo.indexing_status === "INDEXING" ? "Indexing" : "Pending"}
          </span>
        ) : repo.indexing_status === "INDEXED" ? (
          <span className="shrink-0 inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20">
            Indexed
          </span>
        ) : (
          <span className="shrink-0 inline-flex items-center rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-500/20 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-500/20">
            Unindexed
          </span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                (repo.language && LANGUAGE_DOT[repo.language]) ||
                  "bg-slate-400",
              )}
            />
            {repo.language || "Unknown"}
          </span>
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            {repo.default_branch}
          </span>
          <span className="hidden sm:inline">
            {repo.source_type === "public_import" ? "Imported" : "Connected"}
          </span>
        </div>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {new Date(repo.updated_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex translate-y-full items-center justify-around bg-slate-50/95 p-3 backdrop-blur transition-transform duration-200 ease-in-out group-hover:translate-y-0 dark:bg-slate-800/95 border-t border-slate-200 dark:border-slate-700">
        <Link
          to={`/repositories/${repo.id}`}
          className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
        >
          <FileCode2 className="h-4 w-4" /> Open
        </Link>
        <Link
          to={`/repositories/${repo.id}/pulls`}
          className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
        >
          <GitPullRequest className="h-4 w-4" /> Review
        </Link>
        <Link
          to={`/repositories/${repo.id}/chat`}
          className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
        >
          <MessageSquare className="h-4 w-4" /> Ask
        </Link>
        <Link
          to={`/repositories/${repo.id}/interview`}
          className="flex flex-col items-center gap-1 text-[10px] font-medium text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
        >
          <PlayCircle className="h-4 w-4" /> Interview
        </Link>
      </div>
    </div>
  );
}
