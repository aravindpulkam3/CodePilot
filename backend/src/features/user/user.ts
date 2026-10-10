/** Raw row shape of the `app_users` table (snake_case, as Postgres returns it). */
export interface AppUserRow {
  id: string;
  clerk_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  github_connected: boolean;
  github_username: string | null;
  created_at: string;
  updated_at: string;
}

/** camelCase shape sent to the frontend — see frontend/src/types/user.ts */
export interface AppUserDto {
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

/**
 * Clerk's Backend API and webhooks report GitHub as `oauth_github`, not
 * `github` — comparing against `github` alone never matched, so
 * `github_connected` stayed false forever. Accept both spellings.
 */
export function isGitHubProvider(provider: string): boolean {
  return provider === "oauth_github" || provider === "github";
}

export function toUserDto(row: AppUserRow): AppUserDto {
  return {
    id: row.id,
    clerkId: row.clerk_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    githubConnected: row.github_connected,
    githubUsername: row.github_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
