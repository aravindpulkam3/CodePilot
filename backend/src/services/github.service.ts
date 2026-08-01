import { clerkClient } from '@clerk/express';
import axios from 'axios';
import * as repositoryService from './repository.service.js';
/**
 * Retrieves the GitHub OAuth access token from Clerk for a given user.
 */
const getGitHubAccessToken = async (userId: string): Promise<string> => {
  try {
    // Drop the 'oauth_' prefix to resolve the deprecation warning
    const response = await clerkClient.users.getUserOauthAccessToken(userId, 'github');
    
    // Access the tokens array via the 'data' property of the paginated response
    if (!response || !response.data || response.data.length === 0) {
      throw new Error('GITHUB_NOT_CONNECTED');
    }
    
    return response.data[0].token;
  } catch (error: any) {
    if (error.message === 'GITHUB_NOT_CONNECTED') {
      throw error;
    }
    throw new Error('CLERK_API_FAILURE');
  }
};

/**
 * Fetches the authenticated user's GitHub profile.
 */
export const getGitHubUserProfile = async (userId: string) => {
  const token = await getGitHubAccessToken(userId);

  try {
    const { data } = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    return data;
  } catch (error: any) {
    throw new Error('GITHUB_API_FAILURE');
  }
};

/**
 * Fetches the authenticated user's GitHub repositories.
 */
export const syncAndGetGitHubRepositories = async (clerkUserId: string, appUserId: string) => {
  const token = await getGitHubAccessToken(clerkUserId);

  try {
    // 1. Fetch raw repositories from GitHub API
    const { data: githubRepos } = await axios.get('https://api.github.com/user/repos?sort=updated', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    // 2. Map GitHub's payload into database column format
    const reposToUpsert: repositoryService.UpsertRepoInput[] = githubRepos.map((repo: any) => ({
      userId: appUserId,
      githubRepoId: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      description: repo.description,
      language: repo.language,
      isPrivate: repo.private,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      lastPushedAt: repo.pushed_at,
    }));

    // 3. Upsert into Postgres
    const syncedRepos = await repositoryService.upsertRepositories(appUserId, reposToUpsert);

    return syncedRepos;
  } catch (error: any) {
    if (error.message === 'GITHUB_NOT_CONNECTED' || error.message === 'CLERK_API_FAILURE') {
      throw error;
    }
    throw new Error('GITHUB_API_FAILURE');
  }
};

export const getRepositoryPullRequests = async (clerkUserId: string, repoId: string) => {
  const repo = await repositoryService.findRepositoryById(repoId);
  if (!repo) throw new Error('REPO_NOT_FOUND');

  const token = await getGitHubAccessToken(clerkUserId);

  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls?state=all&sort=updated&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    return data.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged_at: pr.merged_at,
      user: {
        login: pr.user.login,
        avatar_url: pr.user.avatar_url,
      },
      updated_at: pr.updated_at,
      created_at: pr.created_at,
      html_url: pr.html_url,
    }));
  } catch (error: any) {
    throw new Error('GITHUB_API_FAILURE');
  }
};

export const getPullRequestDetails = async (
  clerkUserId: string,
  repositoryId: string,
  pullNumber: number
) => {
  // 1. Using your correct token function
  const token = await getGitHubAccessToken(clerkUserId); 
  
  // 2. Using your correct repository lookup function
  const repo = await repositoryService.findRepositoryById(repositoryId);

  // 3. THE FIX (TS18047): Tell TypeScript we are handling the null case
  if (!repo) {
    throw new Error(`Repository with ID ${repositoryId} not found.`);
  }

  // From this line onward, TypeScript knows 'repo' is safe and not null!
  
  const prResponse = await axios.get(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  const filesResponse = await axios.get(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}/files`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  const prData = prResponse.data;

  return {
    number: prData.number,
    title: prData.title,
    description: prData.body,
    state: prData.state,
    merged: prData.merged,
    head_sha: prData.head.sha, 
    author: {
      login: prData.user.login,
      avatar_url: prData.user.avatar_url,
    },
    additions: prData.additions,
    deletions: prData.deletions,
    changed_files_count: prData.changed_files,
    commits_count: prData.commits,
    created_at: prData.created_at,
    updated_at: prData.updated_at,
    files: filesResponse.data.map((file: any) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch || "",
    })),
  };
};