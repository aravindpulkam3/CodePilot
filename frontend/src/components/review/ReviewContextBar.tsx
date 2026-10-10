import { Link } from "react-router-dom";
import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { cn } from "@/utils/cn";
import { PullRequestDetail } from "@/types/repositoryTypes";
import { Review } from "@/types/reviewTypes";

interface ReviewContextBarProps {
  pr: PullRequestDetail;
  repositoryId: string;
  repoName: string | null;
  latest: Review | null;
  isOutdated: boolean;
  isGenerating: boolean;
  onGenerate: () => void;
  discussionOpen: boolean;
  onToggleDiscussion: () => void;
  /** Narrow workspace: drop the secondary facts so the title keeps room. */
  compact: boolean;
}

/**
 * The review workspace's only chrome row: where you are (repo / PRs / #n
 * title), the PR's state, the review's verdict, and the two page actions.
 * Deliberately text, not badges — color is reserved for the PR state icon
 * and the Outdated warning.
 */
export function ReviewContextBar({
  pr,
  repositoryId,
  repoName,
  latest,
  isOutdated,
  isGenerating,
  onGenerate,
  discussionOpen,
  onToggleDiscussion,
  compact,
}: ReviewContextBarProps) {
  const state = pr.merged
    ? { icon: GitMerge, label: "Merged", color: "text-rv-merged" }
    : pr.state === "open"
      ? { icon: GitPullRequest, label: "Open", color: "text-rv-open" }
      : { icon: GitPullRequestClosed, label: "Closed", color: "text-rv-mute" };
  const StateIcon = state.icon;

  return (
    <div className="relative flex h-10 shrink-0 items-center gap-3.5 whitespace-nowrap border-b border-rv-hair bg-rv-chrome pl-4 pr-3 text-xs text-rv-mute">
      <nav aria-label="Breadcrumb" className="flex shrink-0 items-center gap-1.5">
        <Link to={`/repositories/${repositoryId}`} className="hover:text-rv-ink">
          {repoName ?? "Repository"}
        </Link>
        <span className="text-rv-lnc">/</span>
        <Link to={`/repositories/${repositoryId}/pulls`} className="hover:text-rv-ink">
          Pull requests
        </Link>
        <span className="text-rv-lnc">/</span>
      </nav>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 font-mono">#{pr.number}</span>
        <h1 className="truncate font-sans text-[13px] font-semibold tracking-normal text-rv-ink" title={pr.title}>
          {pr.title}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-1.5 text-rv-ink2">
          <StateIcon className={cn("h-3.5 w-3.5", state.color)} />
          {state.label}
        </span>
        {!compact && pr.base_ref && (
          <span>
            into <span className="font-mono">{pr.base_ref}</span>
          </span>
        )}
        {!compact && (
          <span className="font-mono">
            +{pr.additions.toLocaleString()} −{pr.deletions.toLocaleString()}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {latest && (
          <span>
            {latest.overall_score === null ? "Partial review" : <>Review <b className="font-mono font-semibold text-rv-ink">{latest.overall_score}</b></>}
            {!compact && latest.risk_level && <> · {latest.risk_level.toLowerCase()} risk</>}
          </span>
        )}
        {isOutdated && latest && (
          <span
            className="text-rv-warn"
            title={`Reviewed ${latest.head_sha.slice(0, 7)} · the PR is now at ${pr.head_sha.slice(0, 7)}`}
          >
            Outdated
          </span>
        )}
        <button
          type="button"
          onClick={onGenerate}
          disabled={isGenerating}
          className={cn(
            "inline-flex h-7 items-center rounded px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70",
            latest
              ? "border border-rv-bd text-rv-ink hover:bg-rv-hover"
              : "border border-signal-600 bg-signal-600 text-white hover:bg-signal-700",
          )}
        >
          {isGenerating ? "Reviewing…" : latest ? "Re-run review" : "Generate review"}
        </button>
        <button
          type="button"
          onClick={onToggleDiscussion}
          aria-pressed={discussionOpen}
          className={cn(
            "inline-flex h-7 items-center rounded border px-2.5 text-xs font-medium transition-colors",
            discussionOpen ? "border-rv-bd bg-rv-sel text-rv-ink" : "border-rv-bd text-rv-ink hover:bg-rv-hover",
          )}
        >
          Discuss
        </button>
      </div>

      {isGenerating && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" aria-hidden="true">
          <div className="rv-progress h-full w-1/4 bg-rv-teal" />
        </div>
      )}
    </div>
  );
}
