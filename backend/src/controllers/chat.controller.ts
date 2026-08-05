// src/controllers/chatController.ts
import { Request, Response } from 'express';
import { chatService } from '../services/chat.service.js';
import { getAuth } from '@clerk/express';

export const handleRepositoryChat = async (req: Request, res: Response) => {
  const { repositoryId } = req.params;
  const { message, sessionId, type } = req.body;
  const {userId:clerkUserId}=getAuth(req) ;

  let currentSessionId = sessionId;
  if (!currentSessionId) {
    currentSessionId = await chatService.createSession(repositoryId, type);
  }

  await chatService.saveMessage(currentSessionId, 'user', message);

  const recentHistory = await chatService.getRecentHistory(currentSessionId, 10);

  try {
    // Set headers for Server-Sent Events (SSE) 
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ type: 'sessionId', data: currentSessionId })}\n\n`);

    let fullAiResponse = "";

    // Call the service and pass a callback that writes directly to the response object [cite: 1485]
    if(!clerkUserId) throw new Error("clerk user Id not authorised");
    await chatService.streamRepositoryChat(
      clerkUserId,
      repositoryId, 
      message, 
      recentHistory || [], 
      (chunk) => { //
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);

      // 2. ONLY append to our database string if it is actual text
      if (chunk.type === 'text') {
        fullAiResponse += chunk.data;
      }
    }
    );

    await chatService.saveMessage(currentSessionId, 'assistant', fullAiResponse);

    res.end(); // Close stream when finished
  } catch (error) {
    console.error("Chat Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate chat response" });
    } else {
      res.end();
    }
  }
};

export const getSessions = async (req: Request, res: Response) => {
  try {
    const { repositoryId } = req.params;
    const type = (req.query.type as 'QA' | 'REVIEW' | 'INTERVIEW') || 'QA';

    const sessions = await chatService.getSessionsByRepository(repositoryId, type);
    res.json(sessions);
  } catch (error) {
    console.error("Error fetching sessions:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
};

export const getMessages = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const messages = await chatService.getSessionHistory(sessionId);
    res.json(messages);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
};