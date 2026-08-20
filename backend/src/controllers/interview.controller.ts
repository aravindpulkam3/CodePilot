import { Request, Response } from "express";
import { interviewService } from "../services/interview.service.js";

export const startInterview = async (req: Request, res: Response) => {
  try {
    const { config } = req.body;
    const userId = req.dbUser!.id;
    const clerkUserId = req.dbUser!.clerkId;

    if (!config || !config.mode || !config.difficulty) {
      return res.status(400).json({ error: "Invalid interview config" });
    }

    console.log("in the contr to start the interview");

    const { sessionId, firstQuestion } = await interviewService.startInterview(
      userId,
      config,
      clerkUserId,
    );
    res.json({ sessionId, firstQuestion });
  } catch (error) {
    console.error("Start Interview Error:", error);
    res.status(500).json({ error: "Failed to start interview" });
  }
};

export const answerQuestion = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { answer } = req.body;
    const userId = req.dbUser!.id;
    const clerkUserId = req.dbUser!.clerkId;

    if (!answer) {
      return res.status(400).json({ error: "Answer is required" });
    }

    const result = await interviewService.processAnswer(
      sessionId,
      userId,
      answer,
      clerkUserId,
    );
    res.json(result);
  } catch (error) {
    console.error("Answer Question Error:", error);
    res.status(500).json({ error: "Failed to process answer" });
  }
};

export const endInterview = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.dbUser!.id;
    await interviewService.endInterview(sessionId, userId);
    res.json({ message: "Interview ended" });
  } catch (error) {
    console.error("End Interview Error:", error);
    res.status(500).json({ error: "Failed to end interview" });
  }
};

export const generateInsights = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.dbUser!.id;
    const assessment = await interviewService.generateInsights(sessionId, userId);
    res.json(assessment);
  } catch (error) {
    console.error("Generate Insights Error:", error);
    res.status(500).json({ error: "Failed to generate insights" });
  }
};
