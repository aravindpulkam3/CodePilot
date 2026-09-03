import { useEffect } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { GitPullRequest, Terminal, PlayCircle, ChevronRight } from "lucide-react";
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

  const { data: pulls = [] } = useRepositoryPullRequests(repositoryId!);
  const { data: chatSessions = [] } = useChatSessions(repositoryId!, "QA");
  const { data: interviewSessions = [] } = useChatSessions(repositoryId!, "INTERVIEW");

  const tiles = [
    {
      label: "Pull Requests",
      count: pulls.length,
      icon: GitPullRequest,
      to: `/repositories/${repositoryId}/pulls`,
    },
    {
      label: "Codebase Q&A",
      count: chatSessions.length,
      icon: Terminal,
      to: `/repositories/${repositoryId}/chat`,
    },
    {
      label: "Interviews",
      count: interviewSessions.length,
      icon: PlayCircle,
      to: `/repositories/${repositoryId}/interview`,
    },
  ];

  return (
    <div className="max-w-2xl space-y-2">
      {tiles.map(({ label, count, icon: Icon, to }) => (
        <Link
          key={to}
          to={to}
          className="flex items-center justify-between rounded-lg border border-border-light bg-surface-light px-4 py-3 text-sm transition-colors hover:border-signal-500/50 dark:border-border-dark dark:bg-surface-dark"
        >
          <span className="flex items-center gap-2.5 font-medium text-ink-light dark:text-ink-dark">
            <Icon className="h-4 w-4 text-muted-light dark:text-muted-dark" />
            {label}
          </span>
          <span className="flex items-center gap-2 text-muted-light dark:text-muted-dark">
            {count}
            <ChevronRight className="h-4 w-4" />
          </span>
        </Link>
      ))}
    </div>
  );
}
