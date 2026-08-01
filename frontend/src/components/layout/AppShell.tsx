import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar/Sidebar";
import { Navbar } from "./navbar/Navbar";
import { useApiClient } from "@/hooks/useApiClient";

/**
 * The authenticated application frame: Sidebar + Navbar + a scrollable
 * content area rendering the current route via <Outlet />. Mounted once
 * by the protected route group in routes/index.tsx.
 */
export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useApiClient();

  return (
    <div className="flex min-h-screen bg-canvas-light dark:bg-canvas-dark">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar onOpenMobileSidebar={() => setMobileOpen(true)} />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
