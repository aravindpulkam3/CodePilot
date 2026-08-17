import { Router } from "express";
import {
  startInterview,
  answerQuestion,
} from "../controllers/interview.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const interviewRouter = Router();

interviewRouter.post("/start", requireAuth, startInterview);
interviewRouter.post("/:sessionId/answer", requireAuth, answerQuestion);

export default interviewRouter;
