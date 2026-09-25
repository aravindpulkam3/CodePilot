import { safeErrorDetails } from "../../shared/utils/safeErrorDetails.js";
import { isUuid, positiveInteger, parseGitHubRepositoryUrl } from "../../shared/utils/inputValidation.js";
import { Request, Response } from 'express';
// Adjust the import path for getAuth based on your Clerk setup (e.g., '@clerk/express' for v5)
import { getAuth } from '@clerk/express';
import { getGitHubUserProfile, getPullRequestDetails, getRepositoryPullRequests, syncAndGetGitHubRepositories, getGitHubAccessToken } from '../../infrastructure/github/github.service.js';
import { createPublicRepository, findRepositoriesByUserId, findOwnedRepositoryById } from './repository.service.js';
import axios from 'axios';
import { userService } from '../user/user.service.js';
import { withCache } from '../../shared/utils/cache.js';

const handleGitHubError = (res: Response, error: any) => {
  if (error?.message === 'REPO_NOT_FOUND' || error?.message === 'GITHUB_NOT_FOUND') {
    return res.status(404).json({ error: 'GitHub repository or resource not found.' });
  }
  if (error?.message === 'GITHUB_NOT_CONNECTED') {
    return res.status(400).json({ 
      error: 'GitHub account is not connected to this user profile.' 
    });
  }
  
  if (error?.message === 'CLERK_API_FAILURE') {
    return res.status(502).json({ 
      error: 'Failed to retrieve OAuth token from Clerk.' 
    });
  }

  if (error?.message === 'GITHUB_API_FAILURE') {
    return res.status(502).json({ 
      error: 'Failed to communicate with the GitHub API.' 
    });
  }

  return res.status(500).json({ error: 'An unexpected error occurred.' });
};

export const getUser = async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.dbUser!.clerkId;

    const profile = await getGitHubUserProfile(clerkUserId);
    return res.status(200).json(profile);
    
  } catch (error: any) {
    console.error("[GitHub] getUser failed:", { repositoryId: req.params.repositoryId, ...safeErrorDetails(error) });
    return handleGitHubError(res, error);
  }
};

export const getRepositories = async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.dbUser!.clerkId
    
    const appUserId = req.dbUser!.id

    // Throttle the GitHub sync/upsert, not the read — the repo list itself
    // always comes straight from Postgres so a newly imported/removed repo
    // shows up on the very next request instead of waiting out a TTL.
    await withCache(`github:sync:${appUserId}`, 60, async () => {
      try {
        await syncAndGetGitHubRepositories(clerkUserId, appUserId);
      } catch (e: any) {
        if (e.message !== 'GITHUB_NOT_CONNECTED') {
          throw e;
        }
        // If not connected, we still want to return any 'public_import' repos they might have
      }
      return true;
    });

    const repositories = await findRepositoriesByUserId(appUserId);

    return res.status(200).json(repositories);
    
  } catch (error: any) {
    console.error("[GitHub] getRepositories failed:", { repositoryId: req.params.repositoryId, ...safeErrorDetails(error) });
    return handleGitHubError(res, error);
  }
};

export const getPullRequests = async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.dbUser!.clerkId;
    const repoId = req.params.repositoryId as string;
    if (!isUuid(repoId)) return res.status(400).json({ error: "repositoryId must be a UUID" });

    if (!await findOwnedRepositoryById(repoId, req.dbUser!.id)) {
      return res.status(404).json({ error: "Repository not found." });
    }
    const pulls = await withCache(`repo:${repoId}:pulls`, 90, () =>
      getRepositoryPullRequests(clerkUserId, repoId),
    );
    return res.status(200).json(pulls);
  } catch (error: any) {
    console.error("[GitHub] getPullRequests failed:", { repositoryId: req.params.repositoryId, ...safeErrorDetails(error) });
    return handleGitHubError(res, error);
  }
};

export const getPullRequestDetail = async (req: Request, res: Response) => {
  try {
     const clerkUserId = req.dbUser!.clerkId
    const repoId = req.params.repositoryId as string;
    if (!isUuid(repoId)) return res.status(400).json({ error: "repositoryId must be a UUID" });
    const pullNumber = positiveInteger(req.params.pullNumber);
    if (pullNumber === null) return res.status(400).json({ error: "pullNumber must be a positive integer" });

    if (!await findOwnedRepositoryById(repoId, req.dbUser!.id)) {
      return res.status(404).json({ error: "Repository not found." });
    }
    const prDetail = await withCache(`repo:${repoId}:pr:${pullNumber}:details`, 90, () =>
      getPullRequestDetails(clerkUserId, repoId, pullNumber),
    );
    return res.status(200).json(prDetail);
  } catch (error: any) {
    console.error("[GitHub] getPullRequestDetail failed:", { repositoryId: req.params.repositoryId, ...safeErrorDetails(error) });
    return handleGitHubError(res, error);
  }
};

export const importPublicRepository = async (req: Request, res: Response) => {
  try {
    const appUserId = req.dbUser!.id;
    const parsed = parseGitHubRepositoryUrl(req.body?.repositoryUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid GitHub repository URL.' });
    }
    const { owner, repoName } = parsed;

    // Check if repository exists and is public
    let repoData;
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repoName}`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      repoData = response.data;
    } catch (error: any) {
      if (error.response && error.response.status === 404) {
        return res.status(404).json({ error: 'Repository not found or is private.' });
      }
      throw error;
    }

    if (repoData.private) {
      return res.status(403).json({ error: 'Private repositories cannot be imported via this method.' });
    }

    // Create or reuse repository record
    const repoRecord = await createPublicRepository(appUserId, {
      userId: appUserId,
      githubRepoId: repoData.id,
      owner: repoData.owner.login,
      name: repoData.name,
      description: repoData.description,
      language: repoData.language,
      isPrivate: repoData.private,
      defaultBranch: repoData.default_branch,
      htmlUrl: repoData.html_url,
      cloneUrl: repoData.clone_url,
      lastPushedAt: repoData.pushed_at,
    });

    // Importing a public repo by URL only adds it to the user's list, same
    // as GET /github/repositories listing a connected repo — it must NOT
    // join the workspace or trigger indexing on its own. Joining the
    // workspace (and therefore kicking off indexing, via startWorking's own
    // enqueueSync call) only happens once the user explicitly presses
    // "Start Working" on it, exactly like any other listed repo.
    console.log(`[Workspace] Public import ${repoRecord.name} (${repoRecord.id}) added to list, not yet started.`);

    return res.status(200).json({
      repository: {
        id: repoRecord.id,
        name: repoRecord.name,
        fullName: `${repoRecord.owner}/${repoRecord.name}`,
        sourceType: 'public_import',
        indexingStatus: 'NOT_STARTED'
      }
    });
  } catch (error: any) {
    console.error('Error importing public repository:', safeErrorDetails(error));
    if (axios.isAxiosError(error)) {
      return res.status(502).json({ error: 'Failed to communicate with the GitHub API.' });
    }
    return res.status(500).json({ error: 'An unexpected error occurred during import.' });
  }
};
