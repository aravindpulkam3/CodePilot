import { Request, Response } from 'express';
// Adjust the import path for getAuth based on your Clerk setup (e.g., '@clerk/express' for v5)
import { getAuth } from '@clerk/express';
import { getGitHubUserProfile, getPullRequestDetails, getRepositoryPullRequests, syncAndGetGitHubRepositories, getGitHubAccessToken } from '../services/github.service.js';
import { repositorySyncService } from '../services/repositorySync.service.js';
import { createPublicRepository, findRepositoriesByUserId } from '../services/repository.service.js';
import axios from 'axios';
import { userService } from '../services/user.service.js';

const handleGitHubError = (res: Response, error: any) => {
  if (error.message === 'GITHUB_NOT_CONNECTED') {
    return res.status(400).json({ 
      error: 'GitHub account is not connected to this user profile.' 
    });
  }
  
  if (error.message === 'CLERK_API_FAILURE') {
    return res.status(502).json({ 
      error: 'Failed to retrieve OAuth token from Clerk.' 
    });
  }

  if (error.message === 'GITHUB_API_FAILURE') {
    return res.status(502).json({ 
      error: 'Failed to communicate with the GitHub API.' 
    });
  }

  return res.status(500).json({ error: 'An unexpected error occurred.' });
};

export const getUser = async (req: Request, res: Response) => {
  try {
    const userId = req.dbUser!.id;
    

    const profile = await getGitHubUserProfile(userId);
    return res.status(200).json(profile);
    
  } catch (error: any) {
    return handleGitHubError(res, error);
  }
};

export const getRepositories = async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.dbUser!.clerkId
    
    const appUserId = req.dbUser!.id

    // Fetch from GitHub and upsert into Postgres
    try {
      await syncAndGetGitHubRepositories(clerkUserId, appUserId);
    } catch (e: any) {
      if (e.message !== 'GITHUB_NOT_CONNECTED') {
        throw e;
      }
      // If not connected, we still want to return any 'public_import' repos they might have
    }
    
    // Fetch ALL repositories for this user (connected + public_import) from the database
    const repositories = await findRepositoriesByUserId(appUserId);
    return res.status(200).json(repositories);
    
  } catch (error: any) {
    if (error.message === 'GITHUB_NOT_CONNECTED') {
      return res.status(400).json({ error: 'GitHub account is not connected.' });
    }
    if (error.message === 'GITHUB_API_FAILURE') {
      return res.status(502).json({ error: 'Failed to communicate with GitHub API.' });
    }
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
};

export const getPullRequests = async (req: Request, res: Response) => {
  try {
    const clerkUserId = req.dbUser!.clerkId;
    const repoId = req.params.repositoryId as string;

    const pulls = await getRepositoryPullRequests(clerkUserId, repoId);
    return res.status(200).json(pulls);
  } catch (error: any) {
    if (error.message === 'REPO_NOT_FOUND') {
      return res.status(404).json({ error: 'Repository not found.' });
    }
    return res.status(502).json({ error: 'Failed to fetch pull requests from GitHub.' });
  }
};

export const getPullRequestDetail = async (req: Request, res: Response) => {
  try {
     const clerkUserId = req.dbUser!.clerkId
    const repoId = req.params.repositoryId as string;
    const pullNumber = parseInt(req.params.pullNumber as string, 10);

    const prDetail = await getPullRequestDetails(clerkUserId, repoId, pullNumber);
    return res.status(200).json(prDetail);
  } catch (error: any) {
    if (error.message === 'REPO_NOT_FOUND') {
      return res.status(404).json({ error: 'Repository not found.' });
    }
    return res.status(502).json({ error: 'Failed to fetch pull request details from GitHub.' });
  }
};

export const importPublicRepository = async (req: Request, res: Response) => {
  try {
    const appUserId = req.dbUser!.id;
    const { repositoryUrl } = req.body;

    if (!repositoryUrl) {
      return res.status(400).json({ error: 'Repository URL is required.' });
    }

    // Basic validation & extraction of owner/repo
    const match = repositoryUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid GitHub repository URL.' });
    }

    const owner = match[1];
    const repoName = match[2];

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

    // Fire and forget indexing pipeline (don't await)
    repositorySyncService.syncRepository(req.dbUser!.clerkId, repoRecord.id).catch((err) => {
      console.error(`Error syncing public repository ${repoRecord.name}:`, err);
    });

    return res.status(200).json({
      repository: {
        id: repoRecord.id,
        name: repoRecord.name,
        fullName: `${repoRecord.owner}/${repoRecord.name}`,
        sourceType: 'public_import',
        indexingStatus: 'pending'
      }
    });
  } catch (error: any) {
    console.error('Error importing public repository:', error);
    return res.status(500).json({ error: 'An unexpected error occurred during import.' });
  }
};
