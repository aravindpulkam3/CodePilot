import axios from "axios";

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

export function attachAuthToken(getToken: () => Promise<string | null>) {
  apiClient.interceptors.request.use(async (config) => {
    const token = await getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });
}

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Placeholder for centralized error handling (toast, logging, etc.)
    // once those modules exist. Left intentionally thin for now.
    return Promise.reject(error);
  }
);
