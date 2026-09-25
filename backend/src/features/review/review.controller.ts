import { findOwnedRepositoryById } from "../repository/repository.service.js";
import { safeErrorDetails } from "../../shared/utils/safeErrorDetails.js";
import { isUuid, positiveInteger } from "../../shared/utils/inputValidation.js";
import { Request, Response } from "express";
import { getAuth } from "@clerk/express";
import * as reviewServiceModule from "./review.service.js";
import { activityLogService } from "../dashboard/activityLog.service.js";

export const generateReview = async (req: Request, res: Response) => {
  const clerkUserId=req.dbUser!.clerkId;
  try {
    

    const { repositoryId } = req.body ?? {};
    const pullNumber = positiveInteger(req.body?.pullNumber);
    
    if (!isUuid(repositoryId) || pullNumber === null) {
      return res.status(400).json({ error: "repositoryId must be a UUID and pullNumber must be a positive integer" });
    }

    if (!await findOwnedRepositoryById(repositoryId, req.dbUser!.id)) {
      return res.status(404).json({ error: "Repository not found." });
    }
    await activityLogService.logEvent({
      userId: req.dbUser!.id,
      repositoryId,
      activityType: "PR_REVIEW_STARTED",
      metadata: { pullNumber }
    });

    const reviewResult = await reviewServiceModule.reviewService.generateAndStoreReview(clerkUserId, repositoryId, pullNumber);
    
    await activityLogService.logEvent({
      userId: req.dbUser!.id,
      repositoryId,
      activityType: "PR_REVIEW_COMPLETED",
      metadata: { pullNumber, reviewId: reviewResult.reviewId }
    });

    return res.status(200).json(reviewResult);
  } catch (error: any) {
    console.error("Error in generateReview controller:", { repositoryId: req.body?.repositoryId, pullNumber: req.body?.pullNumber, ...safeErrorDetails(error) });

    if (error?.message === "REPO_NOT_FOUND" || error?.message === "GITHUB_NOT_FOUND") {
      return res.status(404).json({ error: "Repository or pull request not found." });
    }
    if (error?.message === "GITHUB_NOT_CONNECTED") {
      return res.status(400).json({ error: "GitHub account is not connected." });
    }
    if (error?.message === "GITHUB_API_FAILURE" || error?.message === "CLERK_API_FAILURE") {
      return res.status(502).json({ error: "Failed to communicate with GitHub or retrieve its access token." });
    }
    if (error?.message === "INDEXING_IN_PROGRESS") {
      return res.status(409).json({
        error: "This repository is still being indexed. Please try again in a moment.",
      });
    }
    if (error?.message === "INDEXING_FAILED") {
      return res.status(409).json({
        error: "Indexing failed for this repository, so a review can't be generated yet. Try syncing again.",
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getPullRequestReviews = async (req: Request, res: Response) => {
  try {
    const { repositoryId } = req.params;
    const pullNumber = positiveInteger(req.params.pullNumber);
    if (!isUuid(repositoryId) || pullNumber === null) {
      return res.status(400).json({ error: "repositoryId must be a UUID and pullNumber must be a positive integer" });
    }
    if (!await findOwnedRepositoryById(repositoryId, req.dbUser!.id)) {
      return res.status(404).json({ error: "Repository not found." });
    }
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