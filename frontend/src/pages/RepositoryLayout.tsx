import { useParams, Outlet } from "react-router-dom";
import { useRepositoryDetails } from "@/hooks/useRepository";
import { ErrorState } from "@/components/ui/ErrorState";
import { RepositoryHeader } from "@/components/repository/RepositoryHeader";
import { RepositorySubNav } from "@/components/repository/RepositorySubNav";

/**
 * Nested workspace root for everything scoped to one repository. Fetches
 * the repo once here (TanStack Query dedupes the same query key for any
 * child page that also needs it) and owns the loading/error/not-found
 * gate, so no child route has to re-guard "does this repo exist."
 */
export default function RepositoryLayout() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
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
    return <ErrorState message="Couldn't load this repository." onRetry={() => refetch()} />;
  }

  if (!repo) {
    return (
      <div className="py-12 text-center text-sm text-red-500">
        Repository not found.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RepositoryHeader repo={repo} />
      <RepositorySubNav repositoryId={repositoryId!} />
      <div className="min-h-0 flex-1 pt-6">
        <Outlet />
      </div>
    </div>
  );
}
