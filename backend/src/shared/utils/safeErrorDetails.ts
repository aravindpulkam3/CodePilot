/** Only diagnostic codes/statuses: never messages, bodies, headers or request config. */
export function safeErrorDetails(value: unknown): {
  code?: string;
  status?: number;
} {
  const error = value as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  } | null;
  const code = error?.code;
  const status = error?.response?.status ?? error?.status;
  return {
    ...(typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
      ? { code }
      : {}),
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { status }
      : {}),
  };
}
