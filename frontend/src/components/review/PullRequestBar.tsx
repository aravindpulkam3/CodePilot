import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw, PanelRightClose, PanelRightOpen, GitMerge, GitPullRequest, XCircle, History } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { PullRequestDetail } from "@/types/repositoryTypes";
import { Review, ReviewHistoryItem } from "@/types/reviewTypes";

interface PullRequestBarProps {
  pr: PullRequestDetail;
  repositoryId: string;
  latest: Review | null;
  history: ReviewHistoryItem[];
  isOutdated: boolean;
  onGenerateReview: () => void;
  isGenerating: boolean;
  aiPanelOpen: boolean;
  onToggleAiPanel: () => void;
}

/**
 * The PR Review page's entire chrome — a single flat ~52px toolbar row,
 * not a stacked header. RepositoryLayout renders nothing above this on
 * the PR details route, so this bar owns 100% of the page's identity/
 * status/actions in the space that used to be ~350-400px of repo header +
 * PageHeader + tab strip.
 */
export function PullRequestBar({
  pr,
  repositoryId,
  latest,
  history,
  isOutdated,
  onGenerateReview,
  isGenerating,
  aiPanelOpen,
  onToggleAiPanel,
}: PullRequestBarProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const statePill = pr.merged ? (
    <Badge tone="signal">
      <GitMerge className="mr-1 h-3 w-3" /> Merged
    </Badge>
  ) : pr.state === "open" ? (
    <Badge tone="signal">
      <GitPullRequest className="mr-1 h-3 w-3" /> Open
    </Badge>
  ) : (
    <Badge tone="neutral">
      <XCircle className="mr-1 h-3 w-3" /> Closed
    </Badge>
  );

  return (
    <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border-light dark:border-border-dark">
      <Link
        to={`/repositories/${repositoryId}/pulls`}
        className="flex shrink-0 items-center text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
        title="Back to Pull Requests"
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>

      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-mono text-xs text-muted-light dark:text-muted-dark">
          #{pr.number}
        </span>
        <h1 className="truncate text-sm font-medium text-ink-light dark:text-ink-dark">
          {pr.title}
        </h1>
      </div>

      {statePill}

      <span className="hidden shrink-0 items-center gap-1 font-mono text-xs sm:flex">
        <span className="text-emerald-600 dark:text-emerald-400">+{pr.additions}</span>
        <span className="text-rose-600 dark:text-rose-400">-{pr.deletions}</span>
      </span>

      {pr.author?.login && (
        <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-light dark:text-muted-dark md:flex">
          <img src={pr.author.avatar_url} alt="" className="h-4 w-4 rounded-full" />
          {pr.author.login}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {latest && (
          <div className="relative hidden items-center gap-1.5 text-xs lg:flex">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-1.5"
              title="Review history"
            >
              <Badge tone={isOutdated ? "amber" : "signal"}>
                Score {latest.overall_score}/100
              </Badge>
              {latest.risk_level && (
                <Badge tone="neutral">{latest.risk_level} risk</Badge>
              )}
              {isOutdated && <span className="text-amber-500">Outdated</span>}
              {history.length > 0 && <History className="h-3.5 w-3.5 text-muted-light dark:text-muted-dark" />}
            </button>
            {historyOpen && (
              <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-md border border-border-light bg-surface-light py-1 shadow-panel dark:border-border-dark dark:bg-surface-dark">
                <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-light dark:text-muted-dark">
                  Review History
                </div>
                {history.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-light dark:text-muted-dark">No past reviews.</div>
                ) : (
                  history.map((h) => (
                    <div key={h.id} className="px-3 py-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-ink-light dark:text-ink-dark">Score {h.overall_score}/100</span>
                        <span className="text-muted-light dark:text-muted-dark">{new Date(h.created_at).toLocaleDateString()}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-muted-light dark:text-muted-dark">{h.summary}</p>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        <Button size="sm" variant="secondary" onClick={onGenerateReview} disabled={isGenerating}>
          <RefreshCw className={`h-3.5 w-3.5 ${isGenerating ? "animate-spin" : ""}`} />
          {isGenerating
            ? "Analyzing…"
            : isOutdated
              ? "Re-analyze"
              : latest
                ? "Re-run Review"
                : "Generate Review"}
        </Button>

        <button
          onClick={onToggleAiPanel}
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-light hover:bg-black/[.03] hover:text-ink-light dark:text-muted-dark dark:hover:bg-white/[.04] dark:hover:text-ink-dark"
          title={aiPanelOpen ? "Hide AI panel" : "Show AI panel"}
        >
          {aiPanelOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRightOpen className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
