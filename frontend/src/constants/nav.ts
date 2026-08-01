import { ROUTES } from "./routes";

export type NavItem = {
  label: string;
  path: string;
  /** lucide-style icon key, resolved in Sidebar to keep this file dependency-free */
  icon: "layout-dashboard" | "folder-git-2" | "book-open" | "user" | "settings";
};

/**
 * Sidebar navigation, in display order. Adding a future module (e.g.
 * "AI Chat") means appending one entry here and one route — the guard,
 * layout, and sidebar all pick it up automatically.
 */
export const SIDEBAR_NAV: NavItem[] = [
  { label: "Dashboard", path: ROUTES.dashboard, icon: "layout-dashboard" },
  { label: "Repositories", path: ROUTES.repositories, icon: "folder-git-2" },
  { label: "Documentation", path: ROUTES.documentation, icon: "book-open" },
  { label: "Profile", path: ROUTES.profile, icon: "user" },
  { label: "Settings", path: ROUTES.settings, icon: "settings" },
];
