import { clerkClient } from "@clerk/express";
import { pool } from "../config/db.js";
import type { AppUserRow } from "../types/user.js";

/**
 * Data access for the `app_users` table. This is the ONLY module that
 * writes SQL for users — controllers and webhook handlers call these
 * functions rather than querying `pool` directly, so the query shape
 * stays in one place when the schema evolves.
 */
export const userService = {

  /**
   * Fetches the real profile from Clerk's Backend API and upserts it.
   * The Clerk *webhook* (routes/webhook.routes.ts) does the same mapping
   * when it fires, but a webhook needs a publicly reachable URL — it
   * never fires against localhost in local dev — so this is the path
   * that actually keeps app_users populated day to day. Used both by
   * GET /users/me and by requireAuth's own bootstrap-on-first-request,
   * so any endpoint can create the row, not just /users/me.
   */
  async syncFromClerkApi(clerkId: string): Promise<AppUserRow> {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    const github = clerkUser.externalAccounts.find((a) => a.provider === "github");

    return userService.upsertFromClerk({
      clerkId,
      email: clerkUser.primaryEmailAddress?.emailAddress ?? "",
      name: clerkUser.fullName,
      avatarUrl: clerkUser.imageUrl || null,
      githubConnected: Boolean(github),
      githubUsername: github?.username ?? null,
    });
  },

  async upsertFromClerk(input: {
    clerkId: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    githubConnected: boolean;
    githubUsername: string | null;
  }): Promise<AppUserRow> {
    const { rows } = await pool.query<AppUserRow>(
      `INSERT INTO app_users (clerk_id, email, name, avatar_url, github_connected, github_username)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (clerk_id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         github_connected = EXCLUDED.github_connected,
         github_username = EXCLUDED.github_username,
         updated_at = now()
       RETURNING *`,
      [
        input.clerkId,
        input.email,
        input.name,
        input.avatarUrl,
        input.githubConnected,
        input.githubUsername,
      ]
    );
    return rows[0];
  },

  async deleteByClerkId(clerkId: string): Promise<void> {
    await pool.query(`DELETE FROM app_users WHERE clerk_id = $1`, [clerkId]);
  },
};
