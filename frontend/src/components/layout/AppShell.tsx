import { useState } from "react";
import { Outlet, useMatch } from "react-router-dom";
import { Sidebar } from "./sidebar/Sidebar";
import { Navbar } from "./navbar/Navbar";
import { cn } from "@/utils/cn";

/**
 * The authenticated application frame: Sidebar + Navbar + a scrollable
 * content area rendering the current route via <Outlet />. Mounted once
 * by the protected route group in routes/index.tsx.
 *
 * The API client's auth interceptor is attached in ProtectedRoute (the
 * parent of this component), not here — it needs to be ready before any
 * child page's data-fetching queries mount, not just before this shell.
 */
export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // The PR review workspace is edge-to-edge: its panes carry their own
  // borders, and page padding would only cost code width.
  const fullBleed = useMatch("/repositories/:repositoryId/pulls/:pullNumber") !== null;

  return (
    <div className="flex h-screen overflow-hidden bg-canvas-light dark:bg-canvas-dark">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar onOpenMobileSidebar={() => setMobileOpen(true)} />
        <main
          className={cn(
            "min-h-0 flex-1",
            fullBleed ? "overflow-hidden" : "overflow-y-auto px-4 py-6 sm:px-6 lg:px-8",
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
