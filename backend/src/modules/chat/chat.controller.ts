import { Request, Response } from "express";
import { chatService } from "./chat.service.js";

export const getOrCreateSession = async (req: Request, res: Response) => {
  try {
    const { type, repositoryId, reviewId, findingId, title } = req.body;
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
    console.error("Error creating/getting session:", error);
    res.status(500).json({ error: error.message || "Failed to initialize session" });
  }
};

export const listSessions = async (req: Request, res: Response) => {
  try {
    const userId = req.dbUser!.id;
    const { type, repositoryId, reviewId, findingId } = req.query;

    const sessions = await chatService.listSessions(userId, {
      type: type as string,
      repositoryId: repositoryId as string,
      reviewId: reviewId as string,
      findingId: findingId as string,
    });

    res.json(sessions);
  } catch (error: any) {
    console.error("Error listing sessions:", error);
    res.status(500).json({ error: error.message || "Failed to list sessions" });
  }
};

export const getSession = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.dbUser!.id;

    const session = await chatService.getSession(sessionId, userId);
    res.json(session);
  } catch (error: any) {
    console.error("Error fetching session:", error);
    res.status(404).json({ error: error.message || "Session not found" });
  }
};

export const getMessages = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.dbUser!.id;
    const messages = await chatService.getMessages(sessionId, userId);
    res.json(messages);
  } catch (error: any) {
    console.error("Error fetching messages:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to fetch messages" });
  }
};

export const sendMessageStream = async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { message, repositoryId, type, findingId, reviewId } = req.body;
  const userId = req.dbUser!.id;
  const clerkUserId = req.dbUser!.clerkId;

  if (!message || !message.trim()) {
    res.status(400).json({ error: "Message content is required" });
    return;
  }

  try {
    let session;
    if (sessionId && sessionId !== "new") {
      session = await chatService.getSession(sessionId, userId);
    } else {
      session = await chatService.getOrCreateSession({
        userId,
        type: type || "REPO_QA",
        repositoryId,
        reviewId,
        findingId,
      });
    }

    // Set Server-Sent Events (SSE) headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Emit resolved session ID
    res.write(
      `data: ${JSON.stringify({ type: "sessionId", data: session.id })}\n\n`
    );

    await chatService.streamMessage(
      session,
      message,
      clerkUserId,
      (chunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    );

    res.end();
  } catch (error: any) {
    console.error("Chat Stream Error:", error);

    const message =
      error.message === "INDEXING_IN_PROGRESS"
        ? "This repository is still being indexed. Please try again in a moment."
        : error.message === "INDEXING_FAILED"
          ? "Indexing failed for this repository. Try syncing again."
          : error.message || "Failed to stream chat response";

    if (!res.headersSent) {
      const status = error.message === "INDEXING_IN_PROGRESS" || error.message === "INDEXING_FAILED" ? 409 : 500;
      res.status(status).json({ error: message });
    } else {
      // SSE headers already sent — surface the error as a stream event
      // instead of silently ending the connection.
      res.write(`data: ${JSON.stringify({ type: "error", data: message })}\n\n`);
      res.end();
    }
  }
};

export const clearMessages = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.dbUser!.id;

    await chatService.clearMessages(sessionId, userId);
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error clearing messages:", error);
    res.status(500).json({ error: error.message || "Failed to clear messages" });
  }
};

export const deleteSession = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.dbUser!.id;

    await chatService.deleteSession(sessionId, userId);
    res.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting session:", error);
    res.status(500).json({ error: error.message || "Failed to delete session" });
  }
};
