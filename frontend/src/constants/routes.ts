
export const ROUTES = {
  landing: "/",
  login: "/login",
  signup: "/signup",
  dashboard: "/dashboard",
  repositories: "/repositories",
  profile: "/profile",
  settings: "/settings",
  repositoryPage: "/repositories/:repositoryId",
} as const;


export const REPOSITORY_ROUTES = {
  overview: "",
  pulls: "pulls",
  pullDetails: "pulls/:pullNumber",
  chat: "chat",
  chatSession: "chat/:sessionId",
  interview: "interview",
  interviewSession: "interview/:sessionId",
} as const;
