import { useParams, Link } from "react-router-dom";
import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { useRepositoryPullRequests } from "@/hooks/useRepository";
import { ErrorState } from "@/components/ui/ErrorState";
import { cn } from "@/utils/cn";
import { isGitHubNotConnected } from "@/utils/githubErrors";
import { relativeTime } from "@/utils/relativeTime";
import { PullRequestItem } from "@/types/repositoryTypes";

function stateOf(pr: PullRequestItem) {
  if (pr.merged_at) return { icon: GitMerge, label: "Merged", color: "text-rv-merged" };
  if (pr.state === "open") return { icon: GitPullRequest, label: "Open", color: "text-rv-open" };
  return { icon: GitPullRequestClosed, label: "Closed", color: "text-rv-mute" };
}

/**
 * The repository's pull requests as one dense list — state, number, title,
 * author and last update per row, in the same visual language as the
 * review workspace it leads into.
 */
export default function RepositoryPulls() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const { data: pulls = [], isLoading, isError, error, refetch } = useRepositoryPullRequests(repositoryId!);

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">Loading pull requests…</div>;
  }

  if (isGitHubNotConnected(error)) {
    return (
      <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">
        Connect your GitHub account to see pull requests and reviews.
      </div>
    );
  }

  if (isError) {
    return <ErrorState message="Couldn't load pull requests." onRetry={() => refetch()} />;
  }

  if (pulls.length === 0) {
    return <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">No pull requests found.</div>;
  }

  return (
    <div className="review-ws h-full overflow-y-auto">
      <ul className="overflow-hidden rounded-md border border-rv-hair bg-rv-code">
        {pulls.map((pr) => {
          const state = stateOf(pr);
          const StateIcon = state.icon;
          return (
            <li key={pr.number} className="border-b border-rv-hair last:border-b-0">
              <Link
                to={`/repositories/${repositoryId}/pulls/${pr.number}`}
                className="flex h-10 items-center gap-3 px-3.5 text-[13px] hover:bg-rv-hover"
              >
                <StateIcon className={cn("h-3.5 w-3.5 shrink-0", state.color)} aria-label={state.label} />
                <span className="w-10 shrink-0 font-mono text-xs text-rv-mute">#{pr.number}</span>
                <span className="min-w-0 flex-1 truncate text-rv-ink" title={pr.title}>
                  {pr.title}
                </span>
                {pr.user?.login && (
                  <span className="hidden shrink-0 items-center gap-1.5 text-xs text-rv-mute sm:flex">
                    <img src={pr.user.avatar_url} alt="" className="h-4 w-4 rounded-full" />
                    {pr.user.login}
                  </span>
                )}
                <span className="w-24 shrink-0 text-right text-xs text-rv-mute">{relativeTime(pr.updated_at)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
