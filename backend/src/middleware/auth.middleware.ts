import { clerkMiddleware, requireAuth } from "@clerk/express";

/**
 * Attaches Clerk auth state (`req.auth`) to every request. Mounted once
 * in app.ts, before routes. This alone does NOT block unauthenticated
 * requests — pair a route with `requireAuthentication` below for that.
 */
export const attachClerkAuth = clerkMiddleware();

/**
 * Route-level guard: 401s any request without a valid Clerk session.
 * Usage: `router.get("/me", requireAuthentication, controller)`.
 */
export const requireAuthentication = requireAuth();
