import { Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { reviewService } from "../services/review.service.js";

export const generateReview = async (req: Request, res: Response) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { repositoryId, pullNumber } = req.body;
    
    if (!repositoryId || !pullNumber) {
      return res.status(400).json({ error: "repositoryId and pullNumber are required" });
    }

    const reviewResult = await reviewService.generateAndStoreReview(userId, repositoryId, pullNumber);
    
    return res.status(200).json(reviewResult);
  } catch (error: any) {
    console.error("Error in generateReview controller:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
};