import { useQuery } from "@tanstack/react-query";
import { fetchGitHubProfile, fetchGitHubRepos } from "@/services/api/githubApi.js";

/**
 * Hook to fetch the authenticated user's GitHub profile.
 */
export function useGitHubUser() {
  return useQuery({
    queryKey: ["github", "user"],
    queryFn: fetchGitHubProfile,
    staleTime: 1000 * 60 * 5, // Keep cache fresh for 5 minutes
  });
}

/**
 * Hook to fetch the authenticated user's GitHub repositories.
 */
export function useGitHubRepositories() {
  return useQuery({
    queryKey: ["github", "repositories"],
    queryFn: fetchGitHubRepos ,
    staleTime: 1000 * 60 * 5, // Keep cache fresh for 5 minutes
  });
}