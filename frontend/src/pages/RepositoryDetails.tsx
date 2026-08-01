import { useParams, Link } from "react-router-dom";
import { useRepositoryDetails, useRepositoryPullRequests } from "@/hooks/useRepository";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { Lock, Globe, GitBranch, GitPullRequest, ArrowLeft, ExternalLink } from "lucide-react";
import { cn } from "@/utils/cn";

export default function RepositoryDetailsPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const { data: repo, isLoading: isRepoLoading } = useRepositoryDetails(repositoryId!);
  const { data: pulls = [], isLoading: isPullsLoading } = useRepositoryPullRequests(repositoryId!);

  if (isRepoLoading) {
    return <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">Loading repository details...</div>;
  }

  if (!repo) {
    return <div className="py-12 text-center text-sm text-red-500">Repository not found.</div>;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <Link to="/dashboard" className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Dashboard
        </Link>
        <PageHeader title={repo.name} description={repo.description || "No description provided."} />
      </div>

      {/* Metadata Card */}
      <Card>
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">Visibility</span>
            <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-light dark:text-ink-dark">
              {repo.is_private ? <Lock className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
              {repo.is_private ? "Private" : "Public"}
            </div>
          </div>
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">Language</span>
            <p className="mt-1 text-sm font-medium text-ink-light dark:text-ink-dark">{repo.language || "N/A"}</p>
          </div>
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">Default Branch</span>
            <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-light dark:text-ink-dark">
              <GitBranch className="h-4 w-4" />
              {repo.default_branch}
            </div>
          </div>
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">Last Pushed</span>
            <p className="mt-1 text-sm font-medium text-ink-light dark:text-ink-dark">
              {repo.last_pushed_at ? new Date(repo.last_pushed_at).toLocaleDateString() : "N/A"}
            </p>
          </div>
        </CardBody>
      </Card>

      {/* Pull Requests List */}
      <div>
        <div className="mb-4 flex items-center justify-between border-b border-border-light pb-2 dark:border-border-dark">
          <h3 className="text-lg font-medium text-ink-light dark:text-ink-dark">Pull Requests</h3>
        </div>

        {isPullsLoading ? (
          <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">Loading pull requests...</div>
        ) : pulls.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">No pull requests found.</div>
        ) : (
          <div className="space-y-3">
            {pulls.map((pr) => {
              const isMerged = !!pr.merged_at;
              const isOpen = pr.state === "open";

              return (
                <Link key={pr.number} to={`/repositories/${repositoryId}/pulls/${pr.number}`}>
                  <Card className="transition-colors hover:border-slate-300 dark:hover:border-slate-700">
                    <CardBody className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-3">
                        <GitPullRequest
                          className={cn(
                            "h-5 w-5",
                            isOpen ? "text-green-500" : isMerged ? "text-purple-500" : "text-red-500"
                          )}
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-base font-medium text-ink-light dark:text-ink-dark">#{pr.number} {pr.title}</h4>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-xs font-medium uppercase",
                                isOpen
                                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                  : isMerged
                                  ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
                                  : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                              )}
                            >
                              {isOpen ? "Open" : isMerged ? "Merged" : "Closed"}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-light dark:text-muted-dark">
                            Opened by {pr.user.login} • Updated {new Date(pr.updated_at).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <ExternalLink className="h-4 w-4 text-muted-light dark:text-muted-dark" />
                    </CardBody>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}