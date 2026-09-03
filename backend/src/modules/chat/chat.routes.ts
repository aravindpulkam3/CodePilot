import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { rateLimit } from "../../middleware/rateLimiter.middleware.js";
import {
  getOrCreateSession,
  listSessions,
  getSession,
  getMessages,
  sendMessageStream,
  clearMessages,
  deleteSession,
} from "./chat.controller.js";

const chatRouter = Router();

chatRouter.use(requireAuth);

// Session endpoints
chatRouter.post("/sessions", rateLimit("chat"), getOrCreateSession);
chatRouter.get("/sessions", listSessions);
chatRouter.get("/sessions/:sessionId", getSession);
chatRouter.delete("/sessions/:sessionId", deleteSession);

// Message & Stream endpoints
chatRouter.get("/sessions/:sessionId/messages", getMessages);
chatRouter.post("/sessions/:sessionId/stream", rateLimit("chat"), sendMessageStream);
chatRouter.delete("/sessions/:sessionId/messages", clearMessages);

// Fallback convenience streaming without prior session lookup
chatRouter.post("/stream", sendMessageStream);

export default chatRouter;
