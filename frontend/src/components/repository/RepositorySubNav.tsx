import { NavLink } from "react-router-dom";
import { LayoutGrid, GitPullRequest, Terminal, PlayCircle } from "lucide-react";
import { cn } from "@/utils/cn";

/**
 * Repository-local sub-nav — deliberately separate from the global
 * Sidebar (frontend/src/constants/nav.ts). This is "what can I do with
 * this repository," not a second global nav.
 */
export function RepositorySubNav({ repositoryId }: { repositoryId: string }) {
  const base = `/repositories/${repositoryId}`;
  const items = [
    { label: "Overview", to: base, icon: LayoutGrid, end: true },
    { label: "Pull Requests", to: `${base}/pulls`, icon: GitPullRequest, end: false },
    { label: "Codebase Q&A", to: `${base}/chat`, icon: Terminal, end: false },
    { label: "Interviews", to: `${base}/interview`, icon: PlayCircle, end: false },
  ];

  return (
    <nav className="flex shrink-0 items-center gap-6 border-b border-border-light dark:border-border-dark">
      {items.map(({ label, to, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-1.5 border-b-2 pb-3 pt-1 text-sm font-medium transition-colors",
              isActive
                ? "border-signal-500 text-ink-light dark:text-ink-dark"
                : "border-transparent text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark",
            )
          }
        >
          <Icon className="h-4 w-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
