import { Router } from "express";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { getMessages, getSessions, handleRepositoryChat } from "../controllers/chat.controller.js";

const chatRouter = Router();

chatRouter.use(requireAuthentication);

chatRouter.post('/repositories/:repositoryId/chat',handleRepositoryChat);
chatRouter.get('/repositories/:repositoryId/sessions',getSessions);
chatRouter.get('/sessions/:sessionId/messages', getMessages);


export default chatRouter;