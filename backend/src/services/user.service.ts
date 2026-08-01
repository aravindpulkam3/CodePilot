import { pool } from "../config/db.js";
import type { AppUserRow } from "../types/user.js";

/**
 * Data access for the `app_users` table. This is the ONLY module that
 * writes SQL for users — controllers and webhook handlers call these
 * functions rather than querying `pool` directly, so the query shape
 * stays in one place when the schema evolves.
 */
export const userService = {
  async findByClerkId(clerkId: string): Promise<AppUserRow | null> {
    const { rows } = await pool.query<AppUserRow>(
      `SELECT * FROM app_users WHERE clerk_id = $1`,
      [clerkId]
    );
    return rows[0] ?? null;
  },

  /**
   * Upserts the application-side user row from a Clerk identity. Called
   * from the `user.created` / `user.updated` webhook handlers so
   * `app_users` stays in sync with Clerk without the frontend ever
   * writing auth data directly.
   */
  async upsertFromClerk(input: {
    clerkId: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    githubConnected: boolean;
    githubUsername: string | null;
  }): Promise<AppUserRow> {
    console.log("upserting");
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
