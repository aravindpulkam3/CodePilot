import { app } from "./app.js";
import { env } from "./config/env.js";
import { closeRedisConnections } from "./config/redis.js";

const server = app.listen(env.port, () => {
  console.log(`AI Engineering Workspace API listening on http://localhost:${env.port}`);
});

const gracefulShutdown = async () => {
  console.log("Shutting down gracefully...");
  server.close(() => {
    console.log("HTTP server closed.");
  });
  await closeRedisConnections();
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
