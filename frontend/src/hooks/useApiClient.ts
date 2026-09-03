import { useAuth } from "@clerk/clerk-react";
import { useEffect, useState } from "react";
import { attachAuthToken } from "@/services/api/clientApi";

/**
 * Wires the Clerk session token into the shared axios instance. Returns
 * `isReady` so the caller (ProtectedRoute) can hold off rendering any
 * authenticated page until the interceptor is actually attached — a
 * plain useEffect here isn't enough on its own: React commits a child's
 * effects (e.g. a page's data-fetching queries) before its parent's, so
 * if a page mounted alongside this hook it could fire its first request
 * before the interceptor exists, going out with no auth token at all.
 */
export function useApiClient() {
  const { getToken } = useAuth();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    attachAuthToken(() => getToken());
    setIsReady(true);
  }, [getToken]);

  return { isReady };
}
