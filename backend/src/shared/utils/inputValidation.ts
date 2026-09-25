export const MAX_MESSAGE_LENGTH = 10_000;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function isValidMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_MESSAGE_LENGTH;
}

export function parseGitHubRepositoryUrl(value: unknown): { owner: string; repoName: string } | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "github.com" || url.username || url.password || url.port) return null;
    const parts = url.pathname.replace(/\/$/, "").split("/");
    if (parts.length !== 3) return null;
    const owner = parts[1];
    const repoName = parts[2].replace(/\.git$/, "");
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) || !/^[a-z\d_.-]{1,100}$/i.test(repoName) || /^\.+$/.test(repoName)) return null;
    return { owner, repoName };
  } catch {
    return null;
  }
}
