import { NextFunction, Request, Response } from "express";

/** Centralized error handler — mounted last in app.ts. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error(err);
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
}
