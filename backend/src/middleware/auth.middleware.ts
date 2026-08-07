import { Request, Response, NextFunction } from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { pool } from "../config/db.js";

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

    if (rows.length === 0) {
      return res.status(401).json({ error: "Unauthorized: User not found in database" });
    }

    // 3. Attach it to the request safely!
    req.dbUser = {
      id: rows[0].id,
      clerkId: clerkId
    };

    next();
  } catch (error) {
    console.error("Middleware error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};