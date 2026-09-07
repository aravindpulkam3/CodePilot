import { useParams, useLocation, Outlet } from "react-router-dom";
import { useRepositoryDetails } from "@/hooks/useRepository";
import { ErrorState } from "@/components/ui/ErrorState";
import { RepositoryHeader } from "@/components/repository/RepositoryHeader";
import { RepositorySubNav } from "@/components/repository/RepositorySubNav";
import { RepositoryWorkspaceBar } from "@/components/repository/RepositoryWorkspaceBar";
import { cn } from "@/utils/cn";

/**
 * Nested workspace root for everything scoped to one repository. Fetches
 * the repo once here (TanStack Query dedupes the same query key for any
 * child page that also needs it) and owns the loading/error/not-found
 * gate, so no child route has to re-guard "does this repo exist."
 */
export default function RepositoryLayout() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const location = useLocation();
  const {
    data: repo,
    isLoading,
    isError,
    refetch,
  } = useRepositoryDetails(repositoryId!);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">
        Loading repository...
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        message="Couldn't load this repository."
        onRetry={() => refetch()}
      />
    );
  }

  if (!repo) {
    return (
      <div className="py-12 text-center text-sm text-red-500">
        Repository not found.
      </div>
    );
  }

  const base = `/repositories/${repositoryId}`;
  const isChatRoute = location.pathname.startsWith(`${base}/chat`);
  const isInterviewRoute = location.pathname.startsWith(`${base}/interview`);
  const isWorkspaceRoute = isChatRoute || isInterviewRoute;
  // PR *details* only (a segment after /pulls/) — the /pulls list itself
  // keeps the standard repo header/sub-nav. The review workspace owns
  // 100% of its own chrome (its own compact PullRequestBar), so no header,
  // sub-nav, or workspace bar is rendered here at all.
  const isPrDetailsRoute = new RegExp(`^${base}/pulls/[^/]+`).test(location.pathname);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isPrDetailsRoute ? null : isWorkspaceRoute ? (
        <RepositoryWorkspaceBar
          repo={repo}
          repositoryId={repositoryId!}
          mode={isChatRoute ? "QA" : "INTERVIEW"}
        />
      ) : (
        <>
          <RepositoryHeader repo={repo} />
          <RepositorySubNav repositoryId={repositoryId!} />
        </>
      )}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          isPrDetailsRoute ? "pt-0" : isWorkspaceRoute ? "pt-3" : "pt-6",
        )}
      >
        <Outlet />
      </div>
    </div>
  );
}
