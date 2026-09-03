// src/controllers/repositoryController.ts
import { Request, Response } from 'express';
import * as repositoryService from '../services/repository.service.js';
import { syncQueue } from '../config/queues.js';

export const getRepositoryById = async (req: Request, res: Response) => {
  try {
    const repoId = req.params.repositoryId as string;
    const repo = await repositoryService.findRepositoryById(repoId);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found.' });
    }

    return res.status(200).json(repo);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to retrieve repository details.' });
  }
};

export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const repositoryId = req.params.repositoryId as string;
    
    // Check the deterministic job ID we set in the sync service
    const jobId = `sync-${repositoryId}`;
    const job = await syncQueue.getJob(jobId);

    if (!job) {
      // If it's not in the queue, check the DB to see if it's already indexed
      const repo = await repositoryService.findRepositoryById(repositoryId);
      if (repo && repo.indexing_status === 'INDEXED') {
        return res.status(200).json({ status: 'completed' });
      } else if (repo && repo.indexing_status === 'FAILED') {
        return res.status(200).json({ status: 'failed' });
      }
      return res.status(404).json({ error: 'Job not found and repo not indexed.' });
    }

    const state = await job.getState();
    const progress = job.progress;

    return res.status(200).json({
      status: state, // 'waiting', 'active', 'completed', 'failed', etc.
      progress
    });
  } catch (error) {
    console.error("Error fetching sync status:", error);
    return res.status(500).json({ error: 'Failed to retrieve sync status.' });
  }
};
