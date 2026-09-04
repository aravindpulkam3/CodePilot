import { useParams, Link } from "react-router-dom";
import { GitPullRequest, ExternalLink } from "lucide-react";
import { useRepositoryPullRequests } from "@/hooks/useRepository";
import { Card, CardBody } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { cn } from "@/utils/cn";

export default function RepositoryPulls() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const {
    data: pulls = [],
    isLoading,
    isError,
    refetch,
  } = useRepositoryPullRequests(repositoryId!);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-muted-light">
        Loading pull requests...
      </div>
    );
  }

  if (isError) {
    return <ErrorState message="Couldn't load pull requests." onRetry={() => refetch()} />;
  }

  if (pulls.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-light">
        No pull requests found.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {pulls.map((pr) => (
        <Link key={pr.number} to={`/repositories/${repositoryId}/pulls/${pr.number}`}>
          <Card className="transition-colors hover:border-slate-300 dark:hover:border-slate-700">
            <CardBody className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <GitPullRequest
                  className={cn(
                    "h-5 w-5",
                    pr.state === "open"
                      ? "text-green-500"
                      : !!pr.merged_at
                        ? "text-purple-500"
                        : "text-red-500",
                  )}
                />
                <div>
                  <h4 className="text-base font-medium">
                    #{pr.number} {pr.title}
                  </h4>
                </div>
              </div>
              <ExternalLink className="h-4 w-4 text-muted-light" />
            </CardBody>
          </Card>
        </Link>
      ))}
    </div>
  );
}