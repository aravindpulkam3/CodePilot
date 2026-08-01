import { Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ProtectedRoute, PublicOnlyRoute } from "@/features/auth";
import { AppShell } from "@/components/layout/AppShell";
import { ROUTES } from "@/constants/routes";

import Landing from "@/pages/Landing";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import Dashboard from "@/pages/Dashboard";
import Repositories from "@/pages/Repositories";
import Documentation from "@/pages/Documentation";
import Profile from "@/pages/Profile";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/NotFound";
import RepositoryDetailsPage from "@/pages/RepositoryDetails";
import PullRequestDetailsPage from "@/pages/PullRequestDetails";

/**
 * Route tree, grouped by access level:
 *  - Landing is fully public.
 *  - Login/Signup sit behind PublicOnlyRoute (redirect away if signed in).
 *  - Everything else nests under ProtectedRoute -> AppShell, so adding a
 *    new authenticated page later is one <Route> line inside that group.
 */
export function AppRoutes() {
  return (
    <ThemeProvider>
      <Routes>
        <Route path={ROUTES.landing} element={<Landing />} />

        {/* Clerk's path-based routing (routing="path" in Login/Signup)
            renders internal sub-steps — e.g. email verification, MFA — as
            nested paths under /login and /signup, so the route needs a
            trailing wildcard or those steps 404. */}
        <Route element={<PublicOnlyRoute />}>
          <Route path={`${ROUTES.login}/*`} element={<Login />} />
          <Route path={`${ROUTES.signup}/*`} element={<Signup />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path={ROUTES.dashboard} element={<Dashboard />} />
            <Route path={ROUTES.repositories} element={<Repositories />} />
            <Route path={ROUTES.repositoryPage} element={<RepositoryDetailsPage />} />
            <Route path={ROUTES.pullRequestDetails} element={<PullRequestDetailsPage/>}/>
            <Route path={ROUTES.documentation} element={<Documentation />} />
            <Route path={ROUTES.profile} element={<Profile />} />
            <Route path={ROUTES.settings} element={<Settings />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </ThemeProvider>
  );
}
