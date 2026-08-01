import { useQuery } from "@tanstack/react-query";
import { getPullRequestDetails, getRepoDetails, getRepoPullRequests } from "@/services/api/repository";

export function useRepositoryDetails(repositoryId: string) {
  return useQuery({
    queryKey: ["repository", repositoryId],
    queryFn: () => getRepoDetails(repositoryId),
    enabled: !!repositoryId,
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

