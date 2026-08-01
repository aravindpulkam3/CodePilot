import { useAuth } from "@clerk/clerk-react";
import { Navigate, Outlet } from "react-router-dom";
import { ROUTES } from "@/constants/routes";
import { FullScreenSpinner } from "@/components/ui/Spinner";

/**
 * Guards routes that should never be seen by a signed-in user (Login,
 * Signup). If a session already exists, skip straight to the Dashboard.
 */
export function PublicOnlyRoute() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <FullScreenSpinner label="Loading…" />;

  if (isSignedIn) return <Navigate to={ROUTES.dashboard} replace />;

  return <Outlet />;
}
