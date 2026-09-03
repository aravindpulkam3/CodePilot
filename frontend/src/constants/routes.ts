/**
 * Central route path registry. Every path used in a <Link>, <Navigate>,
 * or route definition should come from here — no hardcoded strings —
 * so a path can be renamed in one place without hunting through the app.
 */
export const ROUTES = {
  landing: "/",
  login: "/login",
  signup: "/signup",
  dashboard: "/dashboard",
  repositories: "/repositories",
  profile: "/profile",
  settings: "/settings",

  // Repository workspace root. RepositoryLayout mounts here and renders a
  // nested <Outlet/> for every repo-scoped child route below (see
  // REPOSITORY_ROUTES) — Overview/Pull Requests/Codebase Q&A/Interviews
  // are capabilities available *within* a repository, not separate pages.
  repositoryPage: "/repositories/:repositoryId",
} as const;

/**
 * Segments nested under ROUTES.repositoryPage. React Router v6 nested
 * <Route path> values are relative to the parent, so these intentionally
 * do NOT repeat "/repositories/:repositoryId". `overview` is the index
 * route (bare ROUTES.repositoryPage). Used both for <Route path=...>
 * registration and for building concrete hrefs by interpolating
 * repositoryId (and pullNumber/sessionId) directly, matching how the rest
 * of the app already builds links (template strings, not a route-builder
 * helper).
 */
export const REPOSITORY_ROUTES = {
  overview: "",
  pulls: "pulls",
  pullDetails: "pulls/:pullNumber",
  chat: "chat",
  chatSession: "chat/:sessionId",
  interview: "interview",
  interviewSession: "interview/:sessionId",
} as const;
