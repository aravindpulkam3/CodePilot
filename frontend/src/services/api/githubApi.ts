import { apiClient } from "./clientApi.js";
import { GitHubUser, GitHubRepository } from "../../types/githubTypes.js";

// 1. Fetch GitHub Profile
export const fetchGitHubProfile = async () => {
  const { data } = await apiClient.get<GitHubUser>("/github/user");
  return data;
};

// 2. Fetch User Repositories (Returns array)
export const fetchGitHubRepos = async () => {
  const { data } = await apiClient.get<GitHubRepository[]>("/github/repositories");
  return data;
};