import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useImportPublicRepository } from "@/hooks/useGitHub";

/**
 * Shared "import a public repo by URL" modal, used from both Dashboard and
 * the Repositories page so there's one implementation of this flow.
 */
export function ImportRepositoryModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: (repositoryId: string) => void;
}) {
  const [importUrl, setImportUrl] = useState("");
  const importMutation = useImportPublicRepository();

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importUrl) return;

    try {
      const repo = await importMutation.mutateAsync(importUrl);
      onClose();
      onImported?.(repo.id);
    } catch (error) {
      console.error("Failed to import repository", error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
          Import Public Repository
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Enter the URL of any public GitHub repository to import it into your workspace.
        </p>
        <form onSubmit={handleImport}>
          <div className="mb-4">
            <label htmlFor="importUrl" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              GitHub URL
            </label>
            <input
              type="url"
              id="importUrl"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://github.com/owner/repository"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              required
            />
          </div>

          {importMutation.isError && (
            <p className="text-sm text-rose-500 mb-4">
              {(importMutation.error as any)?.response?.data?.error || "Failed to import repository."}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={importMutation.isPending || !importUrl}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {importMutation.isPending && <RefreshCw className="h-4 w-4 animate-spin" />}
              Import Repository
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
