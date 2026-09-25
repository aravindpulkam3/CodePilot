import { NextFunction, Request, Response } from "express";

/** Centralized error handler — mounted last in app.ts. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) return next(err);
  console.error(err);
  // Body-parser errors have fixed public messages; never echo their raw body/message.
  const parserErrors: Record<string, { status: number; message: string }> = {
    "entity.parse.failed": { status: 400, message: "Malformed JSON body" },
    "entity.too.large": { status: 413, message: "Request body too large" },
    "encoding.unsupported": {
      status: 415,
      message: "Unsupported content encoding",
    },
    "charset.unsupported": {
      status: 415,
      message: "Unsupported character set",
    },
    "request.aborted": { status: 400, message: "Request aborted" },
    "request.size.invalid": {
      status: 400,
      message: "Invalid request body size",
    },
  };
  const type = (err as { type?: unknown } | null)?.type;
  const parserError =
    typeof type === "string" && Object.hasOwn(parserErrors, type)
      ? parserErrors[type]
      : undefined;
  res
    .status(parserError?.status ?? 500)
    .json({ error: parserError?.message ?? "Internal server error" });
}
