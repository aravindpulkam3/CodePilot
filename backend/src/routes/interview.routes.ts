import { Router } from "express";
import {
  startInterview,
  answerQuestion,
  endInterview,
  generateInsights,
} from "../controllers/interview.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { rateLimit } from "../middleware/rateLimiter.middleware.js";

const interviewRouter = Router();

// Each answer costs one embedding + one Gemini call; start costs the same
// plus the structural-seed retrieval. Previously unrated, unlike chat/review/sync.
interviewRouter.post("/start", requireAuth, rateLimit("chat"), startInterview);
interviewRouter.post("/:sessionId/answer", requireAuth, rateLimit("chat"), answerQuestion);
interviewRouter.post("/:sessionId/end", requireAuth, endInterview);
interviewRouter.post("/:sessionId/insights", requireAuth, generateInsights);

export default interviewRouter;
