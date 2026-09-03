import { Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "../config/db.js"; // Adjust path to your db pool
import { toUserDto } from "../types/user.js";
import { userService } from "../services/user.service.js";

export async function getMe(req: Request, res: Response) {
  try {
    const { userId: clerkId } = getAuth(req);
    if (!clerkId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { rows } = await pool.query(
      "SELECT * FROM app_users WHERE clerk_id = $1",
      [clerkId],
    );

    let user = rows[0];

    // Create on first sight, and self-heal a row that was previously
    // created without real data (e.g. by an older version of this
    // fallback, or a webhook that fired before GitHub was connected).
    if (!user || !user.email || (!user.name && !user.avatar_url)) {
      user = await userService.syncFromClerkApi(clerkId);
    }

    return res.json(toUserDto(user));
  } catch (error) {
    console.error("Error in getMe:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
