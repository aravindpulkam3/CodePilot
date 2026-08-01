import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  FolderGit2,
  BookOpen,
  User,
  Settings,
  ChevronsLeft,
  Terminal,
} from "lucide-react";
import { SIDEBAR_NAV, type NavItem } from "@/constants/nav";
import { cn } from "@/utils/cn";

const ICONS: Record<NavItem["icon"], typeof LayoutDashboard> = {
  "layout-dashboard": LayoutDashboard,
  "folder-git-2": FolderGit2,
  "book-open": BookOpen,
  user: User,
  settings: Settings,
};

export function Sidebar({
  collapsed,
  onToggle,
  mobileOpen,
  onCloseMobile,
}: {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  return (
    <>
      {/* Mobile scrim */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border-light bg-surface-light transition-[width,transform] duration-200 dark:border-border-dark dark:bg-surface-dark",
          "lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          collapsed ? "lg:w-[68px]" : "lg:w-60",
          "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-border-light px-4 dark:border-border-dark">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-signal-600 text-white">
            <Terminal size={16} strokeWidth={2.5} />
          </div>
          {!collapsed && (
            <span className="truncate font-display text-sm font-semibold">
              Engineering Workspace
            </span>
          )}
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {SIDEBAR_NAV.map((item) => {
            const Icon = ICONS[item.icon];
            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onCloseMobile}
                className={({ isActive }) =>
                  cn(
                    "group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-signal-500/10 text-signal-700 dark:text-signal-300"
                      : "text-muted-light hover:bg-black/[.03] hover:text-ink-light dark:text-muted-dark dark:hover:bg-white/[.04] dark:hover:text-ink-dark"
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cn(
                        "h-1 w-1 rounded-full",
                        isActive ? "bg-signal-500" : "bg-transparent"
                      )}
                    />
                    <Icon size={17} strokeWidth={2} className="shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        <button
          onClick={onToggle}
          className="hidden items-center gap-2 border-t border-border-light px-4 py-3 text-xs font-medium text-muted-light hover:text-ink-light dark:border-border-dark dark:text-muted-dark dark:hover:text-ink-dark lg:flex"
        >
          <ChevronsLeft
            size={15}
            className={cn("transition-transform", collapsed && "rotate-180")}
          />
          {!collapsed && "Collapse"}
        </button>
      </aside>
    </>
  );
}
