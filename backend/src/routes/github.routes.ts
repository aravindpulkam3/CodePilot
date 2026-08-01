import { Router } from 'express';
// Add .js extensions to relative imports
import { getUser, getRepositories } from '../controllers/github.controller.js';
import { requireAuthentication } from '../middleware/auth.middleware.js'; 

const gitHubRouter = Router();

gitHubRouter.use(requireAuthentication);

gitHubRouter.get('/user', getUser);
gitHubRouter.get('/repositories', getRepositories);

export default gitHubRouter;