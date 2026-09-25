import {
  isUuid,
  isValidMessage,
  MAX_MESSAGE_LENGTH,
} from "../../shared/utils/inputValidation.js";
import { Request, Response } from "express";
import { interviewService } from "./interview.service.js";

function respondWithError(res: Response, error: any, fallback: string) {
  if (
    error?.message === "RESOURCE_NOT_FOUND" ||
    error?.message === "Session not found"
  ) {
    return res.status(404).json({ error: "Resource not found" });
  }
  if (error?.message === "INTERVIEW_COMPLETED") {
    return res.status(409).json({ error: "This interview has already ended." });
  }
  if (error?.message === "INTERVIEW_NOT_COMPLETED") {
    return res.status(409).json({ error: "End the interview before generating insights." });
  }
  if (error?.message === "INDEXING_IN_PROGRESS") {
    return res.status(409).json({
      error:
        "This repository is still being indexed. Please try again in a moment.",
    });
  }
  if (error?.message === "INDEXING_FAILED") {
    return res.status(409).json({
      error: "Indexing failed for this repository. Try syncing again.",
    });
  }
  return res.status(500).json({ error: fallback });
}

export const startInterview = async (req: Request, res: Response) => {
  try {
    const { config } = req.body ?? {};
    const userId = req.dbUser!.id;
    const clerkUserId = req.dbUser!.clerkId;

    // Repository-only: the 'general' mode was never reachable from the UI
    // and skipped retrieval entirely — see interviewTypes.ts.
    if (
      !config ||
      !isUuid(config.repositoryId) ||
      !["easy", "medium", "hard", "adaptive"].includes(config.difficulty) ||
      (config.mode !== undefined && config.mode !== "repository")
    ) {
      return res.status(400).json({
        error:
          "Invalid interview config: provide a repository UUID, supported difficulty, and repository mode",
      });
    }

    const { sessionId, firstQuestion } = await interviewService.startInterview(
      userId,
      { ...config, mode: "repository" },
      clerkUserId,
    );
    res.json({ sessionId, firstQuestion });
  } catch (error: any) {
    console.error("Start Interview Error:", error);
    respondWithError(res, error, "Failed to start interview");
  }
};

export const answerQuestion = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId))
      return res.status(400).json({ error: "sessionId must be a UUID" });
    const { answer } = req.body ?? {};
    const userId = req.dbUser!.id;

    if (!isValidMessage(answer)) {
      return res.status(400).json({
        error:
          "Answer must be a non-empty string of at most " +
          MAX_MESSAGE_LENGTH +
          " characters",
      });
    }

    const result = await interviewService.processAnswer(
      sessionId,
      userId,
      answer,
    );
    res.json(result);
  } catch (error: any) {
    console.error("Answer Question Error:", error);
    // Was a bare 500 that discarded error.message — meant the readiness gate
    // now added to follow-up retrieval (assertSearchable) could never surface
    // as the catchable 409 it's supposed to be. See CLAUDE.md's note on
    // callers needing to handle INDEXING_IN_PROGRESS / INDEXING_FAILED.
    respondWithError(res, error, "Failed to process answer");
  }
};

export const endInterview = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId))
      return res.status(400).json({ error: "sessionId must be a UUID" });
    const userId = req.dbUser!.id;
    await interviewService.endInterview(sessionId, userId);
    res.json({ message: "Interview ended" });
  } catch (error) {
    console.error("End Interview Error:", error);
    respondWithError(res, error, "Failed to end interview");
  }
};

export const generateInsights = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId))
      return res.status(400).json({ error: "sessionId must be a UUID" });
    const userId = req.dbUser!.id;
    const assessment = await interviewService.generateInsights(
      sessionId,
      userId,
    );
    res.json(assessment);
  } catch (error) {
    console.error("Generate Insights Error:", error);
    respondWithError(res, error, "Failed to generate insights");
  }
};
