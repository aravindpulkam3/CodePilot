// src/routes/repositoryRoutes.ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { getRepositoryById, getSyncStatus } from '../controllers/repository.controller.js';
import { getPullRequests, getPullRequestDetail } from '../controllers/github.controller.js';

const repoRouter = Router();
repoRouter.use(requireAuth);

repoRouter.get('/:repositoryId', getRepositoryById);
repoRouter.get('/:repositoryId/sync-status', getSyncStatus);
repoRouter.get('/:repositoryId/pulls', getPullRequests);
repoRouter.get('/:repositoryId/pulls/:pullNumber', getPullRequestDetail);


export default repoRouter;