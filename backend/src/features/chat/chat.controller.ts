import { Request, Response } from "express";
import { chatService } from "./chat.service.js";
import {
  isUuid,
  isValidMessage,
  MAX_MESSAGE_LENGTH,
} from "../../shared/utils/inputValidation.js";

const chatTypes = ["REPO_QA", "QA", "REVIEW_CHAT", "REVIEW", "ISSUE_CHAT"];

function chatInputError(
  input: {
    type?: unknown;
    repositoryId?: unknown;
    reviewId?: unknown;
    findingId?: unknown;
  },
  requireContext: boolean,
): string | null {
  const { type, repositoryId, reviewId, findingId } = input;
  if (
    type !== undefined &&
    (typeof type !== "string" ||
      !(requireContext ? chatTypes : [...chatTypes, "INTERVIEW"]).includes(
        type,
      ))
  ) {
    return "Invalid chat type";
  }
  for (const [name, value] of Object.entries({
    repositoryId,
    reviewId,
    findingId,
  })) {
    if (value !== undefined && value !== null && !isUuid(value))
      return name + " must be a UUID";
  }
  if (requireContext) {
    const selectedType = type ?? "REPO_QA";
    if (
      ["REPO_QA", "QA"].includes(selectedType as string) &&
      !isUuid(repositoryId)
    )
      return "repositoryId is required";
    if (
      ["REVIEW_CHAT", "REVIEW"].includes(selectedType as string) &&
      !isUuid(reviewId)
    )
      return "reviewId is required";
    if (selectedType === "ISSUE_CHAT" && !isUuid(findingId))
      return "findingId is required";
  }
  return null;
}

export const getOrCreateSession = async (req: Request, res: Response) => {
  try {
    const { type, repositoryId, reviewId, findingId, title } = req.body ?? {};
    const inputError = chatInputError(
      { type, repositoryId, reviewId, findingId },
      true,
    );
    if (inputError) return res.status(400).json({ error: inputError });
    if (
      title !== undefined &&
      title !== null &&
      (typeof title !== "string" || title.length > 255)
    ) {
      return res
        .status(400)
        .json({ error: "title must be a string of at most 255 characters" });
    }
    const userId = req.dbUser!.id;

    const session = await chatService.getOrCreateSession({
      userId,
      type: type || "REPO_QA",
      repositoryId,
      reviewId,
      findingId,
      title,
    });

    res.json(session);
  } catch (error: any) {
    if (error?.message === "RESOURCE_NOT_FOUND") return res.status(404).json({ error: "Resource not found" });
    // A concurrent first creation won the per-review/per-finding unique
    // index; a retry reuses that session.
    if (error?.code === "23505") {
      return res.status(409).json({ error: "This chat session was just created — please retry." });
    }
    console.error("Error creating/getting session:", error);
    res.status(500).json({ error: "Failed to initialize session" });
  }
};

export const listSessions = async (req: Request, res: Response) => {
  try {
    const userId = req.dbUser!.id;
    const { type, repositoryId, reviewId, findingId } = req.query;
    const inputError = chatInputError(
      { type, repositoryId, reviewId, findingId },
      false,
    );
    if (inputError) return res.status(400).json({ error: inputError });

    const sessions = await chatService.listSessions(userId, {
      type: type as string,
      repositoryId: repositoryId as string,
      reviewId: reviewId as string,
      findingId: findingId as string,
    });

    res.json(sessions);
  } catch (error: any) {
    if (error?.message === "RESOURCE_NOT_FOUND") return res.status(404).json({ error: "Resource not found" });
    console.error("Error listing sessions:", error);
    res.status(500).json({ error: "Failed to list sessions" });
  }
};

export const getSession = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId))
      return res.status(400).json({ error: "sessionId must be a UUID" });
    const userId = req.dbUser!.id;

    const session = await chatService.getSession(sessionId, userId);
    res.json(session);
  } catch (error: any) {
    if (error?.message === "RESOURCE_NOT_FOUND") return res.status(404).json({ error: "Resource not found" });
    console.error("Error fetching session:", error);
    const notFound =
      error?.message === "Chat session not found: " + req.params.sessionId;
    res.status(notFound ? 404 : 500).json({
      error: notFound ? "Session not found" : "Failed to fetch session",
    });
  }
};

export const getMessages = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId))
      return res.status(400).json({ error: "sessionId must be a UUID" });
    const userId = req.dbUser!.id;
    const messages = await chatService.getMessages(sessionId, userId);
    res.json(messages);
  } catch (error: any) {
    if (error?.message === "RESOURCE_NOT_FOUND") return res.status(404).json({ error: "Resource not found" });
    console.error("Error fetching messages:", error);
    const status =
      error?.message === "Chat session not found: " + req.params.sessionId
        ? 404
        : 500;
    res.status(status).json({
      error: status === 404 ? "Session not found" : "Failed to fetch messages",
    });
  }
};

export const sendMessageStream = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { message, repositoryId, type, findingId, reviewId } = req.body ?? {};
    const userId = req.dbUser!.id;
    const clerkUserId = req.dbUser!.clerkId;

    if (!isValidMessage(message)) {
      return res.status(400).json({
        error:
          "Message must be a non-empty string of at most " +
          MAX_MESSAGE_LENGTH +
          " characters",
      });
    }
    if (sessionId && sessionId !== "new" && !isUuid(sessionId)) {
      return res.status(400).json({ error: "sessionId must be a UUID" });
    }
    const inputError = chatInputError(
      { type, repositoryId, reviewId, findingId },
      !sessionId || sessionId === "new",
    );
    if (inputError || (type !== undefined && !chatTypes.includes(type))) {
      return res.status(400).json({ error: inputError ?? "Invalid chat type" });
    }
    let session;
    // Whether this is the session's first turn — REPO_QA/QA always create a
    // fresh row via getOrCreateSession (no lookup-and-reuse path, unlike
    // ISSUE_CHAT), so an absent/"new" sessionId reliably means "first turn"
    // for the providers that actually care (RepositoryContextProvider).
    let isNewSession: boolean;
    if (sessionId && sessionId !== "new") {
      session = await chatService.getSession(sessionId, userId);
      // Checked before SSE headers so the client gets a real status code.
      if (session.type === "INTERVIEW") {
        return res.status(409).json({
          error: "Interview sessions can only be continued from the interview page.",
        });
      }
      isNewSession = false;
    } else {
      session = await chatService.getOrCreateSession({
        userId,
        type: type || "REPO_QA",
        repositoryId,
        reviewId,
        findingId,
      });
      isNewSession = true;
    }

    // Set Server-Sent Events (SSE) headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Emit resolved session ID
    res.write(
      `data: ${JSON.stringify({ type: "sessionId", data: session.id })}\n\n`,
    );

    await chatService.streamMessage(
      session,
      message,
      clerkUserId,
      (chunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
      isNewSession,
    );

    res.end();
  } catch (error: any) {
    if (error?.message === "RESOURCE_NOT_FOUND" && !res.headersSent) return res.status(404).json({ error: "Resource not found" });
    console.error("Chat Stream Error:", error);

    const message =
      error?.message === "INDEXING_IN_PROGRESS"
        ? "This repository is still being indexed. Please try again in a moment."
        : error?.message === "INDEXING_FAILED"
          ? "Indexing failed for this repository. Try syncing again."
          : "Failed to stream chat response";

    if (!res.headersSent) {
      const status =
        error?.message === "INDEXING_IN_PROGRESS" ||
        error?.message === "INDEXING_FAILED"
          ? 409
          : 500;
      res.status(status).json({ error: message });
    } else {
      // SSE headers already sent — surface the error as a stream event
      // instead of silently ending the connection.
      res.write(
        `data: ${JSON.stringify({ type: "error", data: message })}\n\n`,
      );
      res.end();
    }
  }
};

export const clearMessages = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId))
      return res.status(400).json({ error: "sessionId must be a UUID" });
    const userId = req.dbUser!.id;

    await chatService.clearMessages(sessionId, userId);
    res.json({ success: true });
  } catch (error: any) {
    if (error?.message === "RESOURCE_NOT_FOUND") return res.status(404).json({ error: "Resource not found" });
    if (error?.message === "INTERVIEW_SESSION_READ_ONLY") {
      return res.status(409).json({ error: "Interview transcripts can't be cleared." });
    }
    console.error("Error clearing messages:", error);
    res.status(500).json({ error: "Failed to clear messages" });
  }
};

export const deleteSession = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!isUuid(sessionId))
      return res.status(400).json({ error: "sessionId must be a UUID" });
    const userId = req.dbUser!.id;

    await chatService.deleteSession(sessionId, userId);
    res.json({ success: true });
  } catch (error: any) {
    if (error?.message === "RESOURCE_NOT_FOUND") return res.status(404).json({ error: "Resource not found" });
    console.error("Error deleting session:", error);
    res.status(500).json({ error: "Failed to delete session" });
  }
};
