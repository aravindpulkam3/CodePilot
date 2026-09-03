// src/routes/reviewRoutes.ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { rateLimit } from '../middleware/rateLimiter.middleware.js';
import { generateReview, getPullRequestReviews } from '../controllers/review.controller.js';

const reviewRouter = Router();
reviewRouter.use(requireAuth);

reviewRouter.post('/', rateLimit('review'), generateReview);
reviewRouter.get("/:repositoryId/pulls/:pullNumber", requireAuth, getPullRequestReviews);

export default reviewRouter;