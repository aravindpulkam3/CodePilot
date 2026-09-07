import { useEffect } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { GitPullRequest, Terminal, PlayCircle, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useRepositoryPullRequests } from "@/hooks/useRepository";
import { useChatSessions } from "@/hooks/useChat";

/**
 * Repository index/landing route. Deliberately lean — a way in to each
 * capability, not a second dashboard. Also handles the legacy `?tab=`
 * links the dashboard's "Continue Working" list still generates
 * server-side (dashboard.controller.ts), so those keep working without
 * a backend change.
 */
export default function RepositoryOverview() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "chat") navigate(`/repositories/${repositoryId}/chat`, { replace: true });
    else if (tab === "interview") navigate(`/repositories/${repositoryId}/interview`, { replace: true });
  }, [searchParams, repositoryId, navigate]);

  const { data: pulls = [], isLoading: pullsLoading } = useRepositoryPullRequests(repositoryId!);
  const { data: chatSessions = [], isLoading: chatLoading } = useChatSessions(repositoryId!, "QA");
  const { data: interviewSessions = [], isLoading: interviewLoading } = useChatSessions(repositoryId!, "INTERVIEW");

  const tiles = [
    {
      label: "Pull Requests",
      description: "Browse and review open pull requests",
      count: pulls.length,
      emptyLabel: "No open pull requests",
      countLabel: (n: number) => `${n} open`,
      icon: GitPullRequest,
      to: `/repositories/${repositoryId}/pulls`,
      isLoading: pullsLoading,
    },
    {
      label: "Codebase Q&A",
      description: "Ask questions grounded in this codebase",
      count: chatSessions.length,
      emptyLabel: "No conversations yet — ask your first question",
      countLabel: (n: number) => `${n} conversation${n === 1 ? "" : "s"}`,
      icon: Terminal,
      to: `/repositories/${repositoryId}/chat`,
      isLoading: chatLoading,
    },
    {
      label: "Interviews",
      description: "Practice a mock technical interview",
      count: interviewSessions.length,
      emptyLabel: "No interviews yet — try one",
      countLabel: (n: number) => `${n} interview${n === 1 ? "" : "s"}`,
      icon: PlayCircle,
      to: `/repositories/${repositoryId}/interview`,
      isLoading: interviewLoading,
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {tiles.map(({ label, description, count, emptyLabel, countLabel, icon: Icon, to, isLoading }) =>
            isLoading ? (
              <Card key={to} className="p-5">
                <div className="mb-3 h-9 w-9 animate-pulse rounded-lg bg-black/[.06] dark:bg-white/[.06]" />
                <div className="mb-2 h-4 w-24 animate-pulse rounded bg-black/[.06] dark:bg-white/[.06]" />
                <div className="h-3 w-32 animate-pulse rounded bg-black/[.06] dark:bg-white/[.06]" />
              </Card>
            ) : (
              <Link key={to} to={to}>
                <Card className="h-full p-5 transition-all hover:border-signal-500/40 hover:shadow-panel">
                  <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-signal-100 text-signal-700 dark:bg-signal-500/10 dark:text-signal-300">
                    <Icon className="h-4.5 w-4.5" />
                  </div>
                  <h3 className="text-sm font-semibold text-ink-light dark:text-ink-dark">
                    {label}
                  </h3>
                  <p className="mt-1 text-xs text-muted-light dark:text-muted-dark">
                    {description}
                  </p>
                  <div className="mt-4 flex items-center justify-between text-xs text-muted-light dark:text-muted-dark">
                    <span>{count === 0 ? emptyLabel : countLabel(count)}</span>
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  </div>
                </Card>
              </Link>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
