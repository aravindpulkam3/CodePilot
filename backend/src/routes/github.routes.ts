import { Router } from 'express';
// Add .js extensions to relative imports
import { getUser, getRepositories, importPublicRepository } from '../controllers/github.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js'; 
import { rateLimit } from '../middleware/rateLimiter.middleware.js';

const gitHubRouter = Router();

gitHubRouter.use(requireAuth);

gitHubRouter.get('/user', getUser);
gitHubRouter.get('/repositories', getRepositories);
gitHubRouter.post('/import', rateLimit('sync'), importPublicRepository);

export default gitHubRouter;