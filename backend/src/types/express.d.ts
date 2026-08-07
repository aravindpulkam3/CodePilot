// The export {} is required to make this file a module
export {};

declare global {
  namespace Express {
    interface Request {
      dbUser?: {
        id: string;       // Your internal Postgres UUID
        clerkId: string;  // The external Clerk ID
      };
    }
  }
}