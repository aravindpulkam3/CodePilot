import { Request, Response } from "express";
import { getAuth } from "@clerk/express";
import * as reviewServiceModule from "../services/review.service.js";

export const generateReview = async (req: Request, res: Response) => {
  const clerkUserId=req.dbUser!.clerkId;
  try {
    

    const { repositoryId, pullNumber } = req.body;
    
    if (!repositoryId || !pullNumber) {
      return res.status(400).json({ error: "repositoryId and pullNumber are required" });
    }

    const reviewResult = await reviewServiceModule.reviewService.generateAndStoreReview(clerkUserId, repositoryId, pullNumber);
    
    return res.status(200).json(reviewResult);
  } catch (error: any) {
    console.error("Error in generateReview controller:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
};

export const getPullRequestReviews = async (req: Request, res: Response) => {
  try {
    const { repositoryId, pullNumber } = req.params;
    const data = await reviewServiceModule.getReviewsForPullRequest(
      repositoryId, 
      Number(pullNumber)
    );
    
    res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching reviews:", error);
    res.status(500).json({ error: "Failed to fetch pull request reviews" });
  }
};