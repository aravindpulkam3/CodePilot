// src/routes/reviewRoutes.ts
import { Router } from 'express';
import { requireAuthentication } from '../middleware/auth.middleware.js';
import { generateReview, getPullRequestReviews } from '../controllers/review.controller.js';

const reviewRouter = Router();
reviewRouter.use(requireAuthentication);

reviewRouter.post('/', generateReview);
reviewRouter.get("/:repositoryId/pulls/:pullNumber", requireAuthentication, getPullRequestReviews);

export default reviewRouter;