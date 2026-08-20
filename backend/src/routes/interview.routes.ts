import { Router } from "express";
import {
  startInterview,
  answerQuestion,
  endInterview,
  generateInsights,
} from "../controllers/interview.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const interviewRouter = Router();

interviewRouter.post("/start", requireAuth, startInterview);
interviewRouter.post("/:sessionId/answer", requireAuth, answerQuestion);
interviewRouter.post("/:sessionId/end", requireAuth, endInterview);
interviewRouter.post("/:sessionId/insights", requireAuth, generateInsights);

export default interviewRouter;
