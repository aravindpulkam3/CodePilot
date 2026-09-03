import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, DownloadCloud, Globe } from "lucide-react";
import { useGitHubRepositories } from "@/hooks/useGitHub";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorState } from "@/components/ui/ErrorState";
import { RepositoryCard } from "@/components/repository/RepositoryCard";
import { ImportRepositoryModal } from "@/components/repository/ImportRepositoryModal";
import { cn } from "@/utils/cn";

export default function Repositories() {
  const navigate = useNavigate();
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const {
    data: repositories = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useGitHubRepositories();

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <PageHeader
          title="Repositories"
          description="Every GitHub repository connected to your account, plus any public repositories you've imported."
        />
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800/50 transition-colors"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Sync
          </button>
          <button
            onClick={() => setIsImportModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
          >
            <DownloadCloud className="h-4 w-4" />
            Import Repository
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 flex items-center justify-center rounded-xl border border-dashed border-slate-300 dark:border-slate-800">
          <p className="text-slate-500 dark:text-slate-400">
            Loading repositories...
          </p>
        </div>
      ) : isError ? (
        <ErrorState
          message="Couldn't load your repositories."
          onRetry={() => refetch()}
        />
      ) : repositories.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 dark:border-slate-800">
          <Globe className="h-8 w-8 text-slate-400 mb-3" />
          <p className="text-slate-500 dark:text-slate-400 font-medium">
            No repositories found
          </p>
          <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
            Import a public repository to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {repositories.map((repo) => (
            <RepositoryCard key={repo.id} repo={repo} />
          ))}
        </div>
      )}

      {isImportModalOpen && (
        <ImportRepositoryModal
          onClose={() => setIsImportModalOpen(false)}
          onImported={(repositoryId) => navigate(`/repositories/${repositoryId}`)}
        />
      )}
    </div>
  );
}
