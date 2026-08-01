// src/routes/reviewRoutes.ts
import { Router } from 'express';
import { requireAuthentication } from '../middleware/auth.middleware.js';
import { generateReview } from '../controllers/review.controller.js';

const reviewRouter = Router();
reviewRouter.use(requireAuthentication);

reviewRouter.post('/', generateReview);

export default reviewRouter;