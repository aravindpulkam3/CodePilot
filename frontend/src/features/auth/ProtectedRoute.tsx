import { useAuth } from "@clerk/clerk-react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { ROUTES } from "@/constants/routes";
import { FullScreenSpinner } from "@/components/ui/Spinner";
import { useApiClient } from "@/hooks/useApiClient";

/**
 * Guards nested routes behind authentication. While Clerk is still
 * resolving the session (`isLoaded === false`) we show a spinner rather
 * than redirecting, so a signed-in user never flashes through the login
 * screen on refresh. Unauthenticated users are sent to Login and the
 * page they wanted is preserved in `state.from`, so Login can send them
 * back after a successful sign-in.
 *
 * The API client's auth interceptor is attached here too (not inside
 * AppShell) specifically so nothing under <Outlet/> — and therefore none
 * of a page's data-fetching queries — mounts until it's confirmed ready.
 */
export function ProtectedRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  const { isReady: isApiClientReady } = useApiClient();
  const location = useLocation();

  if (!isLoaded) return <FullScreenSpinner label="Checking your session…" />;

  if (!isSignedIn) {
    return <Navigate to={ROUTES.login} replace state={{ from: location }} />;
  }

  if (!isApiClientReady) return <FullScreenSpinner label="Loading your workspace…" />;

  return <Outlet />;
}
