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
      [clerkId]
    );

    let user = rows[0];

    if (!user) {
      user = await userService.upsertFromClerk({
        clerkId: clerkId,
        email: "", 
        name: null,
        avatarUrl: null,
        githubConnected: false,
        githubUsername: null,
      });
    }

    // 4. Return the user
    return res.json(toUserDto(user));

  } catch (error) {
    console.error("Error in getMe:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}