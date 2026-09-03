import { Request, Response, NextFunction } from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { pool } from "../config/db.js";
import { userService } from "../services/user.service.js";

export const attachClerkAuth = clerkMiddleware();

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Validate Clerk Token
    const { userId: clerkId } = getAuth(req);
    if (!clerkId) {
      return res.status(401).json({ error: "Unauthorized: No valid Clerk session" });
    }

    // 2. Fetch Internal Database User
    const { rows } = await pool.query(
      "SELECT id FROM app_users WHERE clerk_id = $1",
      [clerkId]
    );

    let dbUserId = rows[0]?.id;

    // The Clerk webhook that normally creates this row can't reach
    // localhost in dev, and even where it can, a signed-in browser can hit
    // several endpoints in parallel before it fires. Bootstrap the row
    // here too (not just in GET /users/me) so no protected endpoint 401s
    // on a valid session just because it happened to run first.
    if (!dbUserId) {
      const user = await userService.syncFromClerkApi(clerkId);
      dbUserId = user.id;
    }

    // 3. Attach it to the request safely!
    req.dbUser = {
      id: dbUserId,
      clerkId: clerkId
    };

    next();
  } catch (error) {
    console.error("Middleware error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};