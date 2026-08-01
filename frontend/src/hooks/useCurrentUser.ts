import { useQuery } from "@tanstack/react-query";
import { usersApi } from "@/services/api/users";

/**
 * Fetches the application-specific user record (see backend `app_users`
 * table) — distinct from Clerk's own `useUser()`, which only has
 * identity/session data. Use this when a screen needs app-side fields
 * like `github_connected`.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: ["users", "me"],
    queryFn: usersApi.getMe,
  });
}
