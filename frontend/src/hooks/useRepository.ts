import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getPullRequestDetails,
  getRepoDetails,
  getRepoPullRequests,
  getRepoSyncStatus,
  startWorkingOnRepo,
  stopWorkingOnRepo,
} from "@/services/api/repositoryApi";

export function useRepositoryDetails(repositoryId: string) {
  return useQuery({
    queryKey: ["repository", repositoryId],
    queryFn: () => getRepoDetails(repositoryId),
    enabled: !!repositoryId,
  });
}

// Two-axis progress polling (no SSE/WebSockets — plain interval polling of
// the existing sync-status endpoint). Keeps polling while background work
// could still be running; stops once the repo is fully READY or has FAILED,
// since neither of those change without a new sync/start-working action.
export function useRepositorySyncStatus(repositoryId: string, enabled = true) {
  return useQuery({
    queryKey: ["repository", repositoryId, "sync-status"],
    queryFn: () => getRepoSyncStatus(repositoryId),
    enabled: !!repositoryId && enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "READY" || status === "FAILED") return false;
      return 3000;
    },
  });
}

export function useStartWorking(repositoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startWorkingOnRepo(repositoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repository", repositoryId] });
      queryClient.invalidateQueries({ queryKey: ["repository", repositoryId, "sync-status"] });
      queryClient.invalidateQueries({ queryKey: ["github", "repositories"] });
    },
  });
}

export function useStopWorking(repositoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => stopWorkingOnRepo(repositoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["repository", repositoryId] });
      queryClient.invalidateQueries({ queryKey: ["github", "repositories"] });
    },
  });
}

export function useRepositoryPullRequests(repositoryId: string) {
  return useQuery({
    queryKey: ["repository", repositoryId, "pulls"],
    queryFn: ()=> getRepoPullRequests(repositoryId),
    enabled: !!repositoryId,
  });
}

export function usePullRequestDetail(repositoryId: string, pullNumber: string) {
  return useQuery({
    queryKey: ["repository", repositoryId, "pulls", pullNumber],
    queryFn: () => getPullRequestDetails(repositoryId,pullNumber),
    enabled: !!repositoryId && !!pullNumber,
  });
}

