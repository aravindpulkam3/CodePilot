import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { attachClerkAuth } from "./middleware/auth.middleware.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRoutes } from "./routes/health.routes.js";
import userRouter from "./routes/user.routes.js";
import { webhookRoutes } from "./routes/webhook.routes.js";
import gitHubRouter from "./routes/github.routes.js";
import repoRouter from "./routes/repository.routes.js";
import reviewRouter from "./routes/review.routes.js";
// import chatRouter from "./routes/chat.routes.js";
import unifiedChatRouter from "./modules/chat/chat.routes.js";
import interviewRouter from "./routes/interview.routes.js";
import dashboardRouter from "./routes/dashboard.routes.js";

export const app = express();

app.use(cors({ origin: env.corsOrigin, credentials: true }));

// Webhooks need the raw body for signature verification, so they're
// mounted BEFORE the json() body parser below.
app.use("/api/webhooks", webhookRoutes);
app.use(express.json());
app.use(attachClerkAuth);

app.use("/api/health", healthRoutes);
app.use("/api/users", userRouter);
app.use("/api/dashboard",dashboardRouter);
app.use("/api/github",gitHubRouter);
app.use("/api/chat", unifiedChatRouter);
// app.use('/api', chatRouter);
app.use("/api/repositories",repoRouter);
app.use("/api/reviews",reviewRouter);
app.use("/api/interview", interviewRouter);


// Reserved mount points for future modules — kept here, unregistered,
// so adding a module is "uncomment a line" rather than a routing
// redesign:
// app.use("/api/repositories", repositoryRoutes);
// app.use("/api/documentation", documentationRoutes);
// app.use("/api/chat", chatRoutes);

app.use(errorHandler);
