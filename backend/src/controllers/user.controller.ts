import { Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { userService } from "../services/user.service.js";
import { toUserDto } from "../types/user.js";

/**
 * GET /api/users/me — returns the application-side user row for the
 * signed-in Clerk identity. Requires `requireAuthentication` on the
 * route. If the row doesn't exist yet (webhook hasn't landed, or it's
 * disabled in local dev), we lazily create a minimal one so the frontend
 * never has to special-case a missing profile.
 */
export async function getMe(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) {

    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  let user = await userService.findByClerkId(userId);
  if (!user) {
    user = await userService.upsertFromClerk({
      clerkId: userId,
      email: "",
      name: null,
      avatarUrl: null,
      githubConnected: false,
      githubUsername: null,
    });
  }
  res.json(toUserDto(user));
}
