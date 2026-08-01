// src/routes/repositoryRoutes.ts
import { Router } from 'express';
import { requireAuthentication } from '../middleware/auth.middleware.js';
import { getRepositoryById } from '../controllers/repository.controller.js';
import { getPullRequests, getPullRequestDetail } from '../controllers/github.controller.js';

const repoRouter = Router();
repoRouter.use(requireAuthentication);

repoRouter.get('/:repositoryId', getRepositoryById);
repoRouter.get('/:repositoryId/pulls', getPullRequests);
repoRouter.get('/:repositoryId/pulls/:pullNumber', getPullRequestDetail);

export default repoRouter;