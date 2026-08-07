import { Request, Response } from 'express';
// Adjust the import path for getAuth based on your Clerk setup (e.g., '@clerk/express' for v5)
import { getAuth } from '@clerk/express';
import {getGitHubUserProfile, getPullRequestDetails, getRepositoryPullRequests, syncAndGetGitHubRepositories } from '../services/github.service.js';
import {userService} from '../services/user.service.js';

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
    const repositories = await syncAndGetGitHubRepositories(clerkUserId, appUserId);
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
