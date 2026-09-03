import axios from "axios";
import { toast } from "sonner";

/**
 * Shared axios instance for all backend calls. The Clerk session token is
 * attached per-request via `attachAuthToken` (called once from
 * `useApiClient`), rather than read from storage here, because Clerk
 * manages token refresh internally and the token is short-lived.
 */
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  headers: { "Content-Type": "application/json" },
});

// Guards against registering a duplicate interceptor if the attaching
// component re-mounts (route re-entry, Fast Refresh) — interceptors stack,
// so calling this more than once would otherwise pile up redundant ones.
let authInterceptorAttached = false;

export function attachAuthToken(getToken: () => Promise<string | null>) {
  if (authInterceptorAttached) return;
  authInterceptorAttached = true;

  apiClient.interceptors.request.use(async (config) => {
    const token = await getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });
}

/**
 * Global safety net: every failed request surfaces a toast, so nothing
 * fails completely silently. Callers can still add their own inline error
 * UI (see ErrorState) for context-specific messaging — this just guarantees
 * a baseline.
 */
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);

    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message ||
      "Something went wrong.";
    toast.error(message);

    return Promise.reject(error);
  }
);
