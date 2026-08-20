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
  documentation: "/documentation",
  profile: "/profile",
  settings: "/settings",
  repositoryPage: "/repositories/:repositoryId",
  pullRequestDetails: "/repositories/:repositoryId/pulls/:pullNumber",
  interviewPage: "/repositories/:repositoryId/interview",
  interviewSessionPage: "/repositories/:repositoryId/interview/:sessionId",
} as const;
