import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy backend/.env.example to backend/.env and fill it in.`
    );
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  clerkPublishableKey: required("CLERK_PUBLISHABLE_KEY"),
  clerkSecretKey: required("CLERK_SECRET_KEY"),
  clerkWebhookSigningSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? "",
  databaseUrl: required("DATABASE_URL"),
};
