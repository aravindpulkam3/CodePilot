import { useAuth } from "@clerk/clerk-react";
import { useEffect } from "react";
import { attachAuthToken } from "@/services/api/client";

/**
 * Wires the Clerk session token into the shared axios instance. Mount
 * once near the app root (done in AppShell) so every screen's API calls
 * are authenticated without each one re-implementing this.
 */
export function useApiClient() {
  const { getToken } = useAuth();

  useEffect(() => {
    attachAuthToken(() => getToken());
  }, [getToken]);
}
