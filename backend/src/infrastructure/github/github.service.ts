import { safeErrorDetails } from "../../shared/utils/safeErrorDetails.js";
import { clerkClient } from '@clerk/express';
import axios from 'axios';
import * as repositoryService from '../../features/repository/repository.service.js';
import { FileChange } from '../../features/repository/repositoryIndex.service.js';
import { logActivity } from '../../features/dashboard/dashboard.service.js';
import { LogActivityType } from '../../features/dashboard/dashboardTypes.js';
import { withCache } from '../../shared/utils/cache.js';
import { cacheRedisClient } from '../../config/redis.js';

/**
 * Retrieves the GitHub OAuth access token from Clerk for a given user.
 */
export const getGitHubAccessToken = async (clerkUserId: string): Promise<string> => {
  try {
    const response = await clerkClient.users.getUserOauthAccessToken(clerkUserId, 'github');
    
    // Access the tokens array via the 'data' property of the paginated response
    if (!response || !response.data || response.data.length === 0) {
      throw new Error('GITHUB_NOT_CONNECTED');
    }
    
    return response.data[0].token;
  } catch (error: any) {
    if (error.message === 'GITHUB_NOT_CONNECTED') {
      throw error;
    }
    console.error(`[GitHub] Clerk OAuth token lookup failed for user ${clerkUserId}:`, safeErrorDetails(error));
    throw new Error('CLERK_API_FAILURE');
  }
};

 //Fetches the authenticated user's GitHub profile.
 
export const getGitHubUserProfile = async (clerkUserId: string) => {
  const token = await getGitHubAccessToken(clerkUserId);

  try {
    const { data } = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    return data;
  } catch (error: any) {
    console.error("[GitHub] profile failed:", { clerkUserId, ...safeErrorDetails(error) });
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.status === 404 ? "GITHUB_NOT_FOUND" : "GITHUB_API_FAILURE");
    }
    throw error;
  }
};

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

    const newlyImportedRepos = syncedRepos.filter(repo => repo.is_new_record === true);

    // 3. Log activity ONLY for the new ones
    if (newlyImportedRepos.length > 0) {
      const logPromises = newlyImportedRepos.map(repo => 
        logActivity(
          appUserId,
          repo.id,
          LogActivityType.REPOSITORY_IMPORTED,
          { repoName: repo.name, provider: "github" }
        )
      );
      
      // Execute all logs concurrently without blocking the main thread return
      Promise.all(logPromises).catch(err => console.error("Failed to log imports", err));
    }

    return syncedRepos;
  } catch (error: any) {
    if (error.message === 'GITHUB_NOT_CONNECTED' || error.message === 'CLERK_API_FAILURE') {
      throw error;
    }
    console.error("[GitHub] repository sync failed:", { clerkUserId, ...safeErrorDetails(error) });
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.status === 404 ? "GITHUB_NOT_FOUND" : "GITHUB_API_FAILURE");
    }
    throw error;
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
    console.error("[GitHub] pull request list failed:", { repoId, ...safeErrorDetails(error) });
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.status === 404 ? "GITHUB_NOT_FOUND" : "GITHUB_API_FAILURE");
    }
    throw error;
  }
};

export const getPullRequestDetails = async (
  clerkUserId: string,
  repositoryId: string,
  pullNumber: number,
  // Lets callers that already loaded the repo row (e.g. review generation)
  // skip a second identical findRepositoryById lookup.
  preFetchedRepo?: repositoryService.RepositoryRow,
) => {
  const token = await getGitHubAccessToken(clerkUserId);

  const repo = preFetchedRepo ?? await repositoryService.findRepositoryById(repositoryId);
  if (!repo) {
    throw new Error("REPO_NOT_FOUND");
  }

  try {
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
      base_sha: prData.base?.sha,
      base_ref: prData.base?.ref,
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
        // Present only for renames. The index holds the OLD path, so review
        // retrieval needs this to find a renamed file's callers and tests.
        previous_filename: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch || "",
      })),
    };
  } catch (error) {
    console.error("[GitHub] Pull request details failed:", { repositoryId, pullNumber, ...safeErrorDetails(error) });
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.status === 404 ? "GITHUB_NOT_FOUND" : "GITHUB_API_FAILURE");
    }
    throw error;
  }
};

/**
 * Raw file content at an arbitrary ref (commit SHA or branch), cached 900 s.
 * Returns null on 404. Also used by PR review to read a changed file at the
 * PR head — the same revision the patch's + line numbers describe.
 */
export async function fetchRawFileContent(token: string | undefined, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    const cacheKey = `github:repo:${owner}:${repo}:file:${ref}:${path}`;
    
    return await withCache(cacheKey, 900, async () => {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
        
        const headers: Record<string, string> = {
            'Accept': 'application/vnd.github.v3.raw' // Crucial: gets the raw text, not the base64 JSON
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`Failed to fetch file content for ${path}: ${response.statusText}`);
        }
        return response.text();
    });
}

/**
 * 1. Gets the latest commit SHA for the repository's default branch.
 */
export async function getLatestCommit(token: string | undefined, owner: string, repo: string) {
    const cacheKey = `github:repo:${owner}:${repo}:latestCommit`;
    const etagKey = `${cacheKey}:etag`;
    
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
        const cachedData = await cacheRedisClient.get(cacheKey);
        const cachedEtag = await cacheRedisClient.get(etagKey);

        //If an ETag was found, it adds the If-None-Match HTTP header. This tells GitHub: "Only send the data if the resource has changed since this specific ETag was issued."
        if (cachedEtag) {
            headers['If-None-Match'] = cachedEtag;
        }

        // Get repo details to find the default branch
        // For production we'd also cache this repo fetch, but keeping focused on the commit fetch
        const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { 
            headers: { 'Accept': 'application/vnd.github.v3+json', ...(token ? {'Authorization': `Bearer ${token}`} : {}) } 
        });
        if (!repoRes.ok) throw new Error("Failed to fetch repository details");
        const repoData = await repoRes.json();
        const defaultBranch = repoData.default_branch;

        // Get the latest commit on the default branch
        const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${defaultBranch}`, { headers });
        
        //A 304 Not Modified response indicates that the resource has not changed since the last time you requested it.
        if (branchRes.status === 304 && cachedData) {
            // ETag match! No rate limit consumed, return cached data
            return JSON.parse(cachedData);
        }

        if (!branchRes.ok) throw new Error("Failed to fetch branch details");
        
        const branchData = await branchRes.json();
        const result = { sha: branchData.commit.sha };
        
        // Cache the new result and ETag
        const newEtag = branchRes.headers.get('etag');
        if (newEtag) {
            await cacheRedisClient.setex(etagKey, 60, newEtag);
            await cacheRedisClient.setex(cacheKey, 60, JSON.stringify(result));
        }

        return result;
    } catch (error) {
        console.error("Failed to fetch latest commit with ETag:", error);
        throw error;
    }
}

/**
 * 2. Compares two commits and returns ONLY the files that changed, with their new content.
 */
export async function getChangedFilesBetweenCommits(
    token: string | undefined, 
    owner: string, 
    repo: string, 
    baseSha: string, 
    headSha: string
): Promise<FileChange[]> {
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const url = `https://api.github.com/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`;
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error("Failed to compare commits");
    const data = await response.json();

    const fileChanges: FileChange[] = [];

    // GitHub's compare API returns an array of 'files'
    for (const file of data.files || []) {
        // Map GitHub's status to our expected status,This line is doing purely TypeScript type-checking work for the developer; it does zero work at runtime when the JavaScript actually runs.
        const status = file.status as 'added' | 'modified' | 'removed' | 'renamed';
        
        let content: string | null = null;

        // Only fetch content if the file wasn't deleted
        if (status !== 'removed') {
            content = await fetchRawFileContent(token, owner, repo, file.filename, headSha);
        }

        // For a rename, GitHub lists the entry under its NEW name only. Without
        // carrying the old one through, the indexer has no way to know the old
        // path existed, so its chunks/edges/summary would be orphaned in the
        // index forever (see processRepositoryUpdate's 'renamed' branch).
        if (status === 'renamed' && !file.previous_filename) {
            console.warn(
                `[GitHub] ${owner}/${repo}: file "${file.filename}" is marked renamed but has no previous_filename — the old path cannot be cleaned up.`,
            );
        }

        fileChanges.push({
            path: file.filename,
            content,
            status,
            ...(status === 'renamed' && file.previous_filename
                ? { previousPath: file.previous_filename as string }
                : {}),
        });
    }

    return fileChanges;
}

/**
 * 3. Does a deep clone of the entire repository tree for the initial sync.
 */
export async function fetchAllRepositoryFiles(
    token: string | undefined, 
    owner: string, 
    repo: string, 
    sha: string
): Promise<FileChange[]> {
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Use the Git Trees API with recursive=1 to get all files in one request
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`;
    const response = await fetch(url, { headers });

    if (!response.ok) throw new Error("Failed to fetch repository tree");
    const data = await response.json();

    const fileChanges: FileChange[] = [];

    // Filter out directories (tree) and keep only files (blob)
    const blobs = data.tree.filter((item: any) => item.type === 'blob');

    // Note: If the repository is massive, this loop should be chunked/paginated
    // to avoid hitting GitHub API rate limits.
    for (const blob of blobs) {
        // Skip lockfiles, build output, vendored deps and binary assets: they
        // produce no index rows, so downloading them is pure wasted requests.
        if (
            blob.path.includes('package-lock.json') ||
            blob.path.startsWith('dist/') ||
            /(^|\/)node_modules\//.test(blob.path) ||
            /\.(wasm|png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|webm|wav|lock)$/i.test(blob.path)
        ) {
            continue;
        }

        const content = await fetchRawFileContent(token, owner, repo, blob.path, sha);
        
        if (content) {
            fileChanges.push({
                path: blob.path,
                content,
                status: 'added'
            });
        }
    }

    return fileChanges;
}