// src/controllers/repositoryController.ts
import { Request, Response } from 'express';
import * as repositoryService from '../services/repository.service.js';

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