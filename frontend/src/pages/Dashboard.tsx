import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGitHubUser, useGitHubRepositories } from "@/hooks/useGitHub.ts";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { GitHubIcon } from "@/components/ui/icons";
import { Lock, Globe, GitBranch, RefreshCw, ExternalLink } from "lucide-react";
import { cn } from "@/utils/cn";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

export default function Dashboard() {
  const { data: user } = useCurrentUser();
  const { data: githubUser, isLoading: isUserLoading } = useGitHubUser();
  const {
    data: repositories = [],
    isLoading: isReposLoading,
    refetch: syncRepositories,
    isFetching: isSyncing,
  } = useGitHubRepositories();

  const firstName = user?.name || githubUser?.name || "Friend";

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description="Manage your connected repositories, recent activity, and workspace status."
      />

      {/* Connection Status Card */}
      <Card>
        <CardBody className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
              <GitHubIcon className="h-6 w-6 text-slate-700 dark:text-slate-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-medium text-ink-light dark:text-ink-dark">
                  Connected to GitHub
                </h2>
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                  <span className="h-2 w-2 rounded-full bg-green-500"></span>
                </span>
              </div>
              <p className="mt-0.5 text-sm text-muted-light dark:text-muted-dark">
                {isUserLoading
                  ? "Loading user profile..."
                  : `@${githubUser?.login ?? "connected"} • Repositories: ${repositories.length}`}
              </p>
            </div>
          </div>
          <button
            onClick={() => syncRepositories()}
            disabled={isSyncing}
            className="flex items-center gap-2 rounded-md bg-ink-light px-4 py-2 text-sm font-medium text-surface-light transition-colors hover:bg-slate-800 dark:bg-ink-dark dark:text-surface-dark dark:hover:bg-slate-200 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", isSyncing && "animate-spin")} />
            Sync
          </button>
        </CardBody>
      </Card>

      {/* Repositories Section */}
      <div>
        <div className="mb-4 flex items-center justify-between border-b border-border-light pb-2 dark:border-border-dark">
          <h3 className="text-lg font-medium text-ink-light dark:text-ink-dark">
            Your Repositories
          </h3>
        </div>

        {isReposLoading ? (
          <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">
            Loading repositories from GitHub...
          </div>
        ) : repositories.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">
            No repositories found.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {repositories.map((repo) => (
              <Card
                key={repo.id}
                className="flex flex-col transition-colors hover:border-slate-300 dark:hover:border-slate-700"
              >
                <CardBody className="flex flex-1 flex-col p-5">
                  <div className="mb-3 flex items-start gap-3">
                    <div className="mt-1 text-muted-light dark:text-muted-dark">
                      {repo.private ? (
                        <Lock className="h-4 w-4" />
                      ) : (
                        <Globe className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <h4 className="truncate text-base font-medium text-ink-light dark:text-ink-dark">
                        {repo.name}
                      </h4>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-light dark:text-muted-dark">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full",
                              repo.language === "TypeScript"
                                ? "bg-blue-500"
                                : repo.language === "JavaScript"
                                  ? "bg-yellow-400"
                                  : repo.language === "C++"
                                    ? "bg-pink-500"
                                    : "bg-slate-400",
                            )}
                          />
                          {repo.language || "Plain Text"}
                        </span>
                        <span>•</span>
                        <span>
                          Updated{" "}
                          {new Date(repo.updated_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mb-5 mt-auto flex items-center gap-2 pt-2 text-xs text-muted-light dark:text-muted-dark">
                    <GitBranch className="h-3.5 w-3.5" />
                    {repo.default_branch}
                  </div>

                  <div className="mt-auto flex items-center gap-2">
                    {/* Internal navigation inside your app */}
                    <Link
                      to={`/repositories/${repo.id}`}
                      className="flex-1 flex items-center justify-center gap-2 rounded-md border border-border-light py-2 text-sm font-medium text-ink-light hover:bg-slate-50 dark:border-border-dark dark:text-ink-dark dark:hover:bg-slate-800/50"
                    >
                      View Repository
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>

                    {/* Optional: External link directly to github.com */}
                    <a
                      href={repo.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="p-2 rounded-md border border-border-light text-muted-light hover:text-ink-light dark:border-border-dark dark:text-muted-dark dark:hover:text-ink-dark"
                      title="Open on GitHub"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
