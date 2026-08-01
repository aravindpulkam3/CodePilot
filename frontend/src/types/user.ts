/** Mirrors the `app_users` Postgres table — see backend/src/db/schema.sql */
export interface AppUser {
  id: string;
  clerkId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  githubConnected: boolean;
  githubUsername: string | null;
  createdAt: string;
  updatedAt: string;
}
