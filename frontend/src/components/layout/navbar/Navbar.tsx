import { UserButton } from "@clerk/clerk-react";
import { Menu, Search, Bell, Sun, Moon } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";

export function Navbar({ onOpenMobileSidebar }: { onOpenMobileSidebar: () => void }) {
  const { theme, toggle } = useTheme();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border-light bg-surface-light/80 px-4 backdrop-blur dark:border-border-dark dark:bg-surface-dark/80">
      <button
        onClick={onOpenMobileSidebar}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-light hover:bg-black/[.04] dark:text-muted-dark dark:hover:bg-white/[.06] lg:hidden"
        aria-label="Open sidebar"
      >
        <Menu size={18} />
      </button>

      {/* Search placeholder */}
      <div className="hidden max-w-sm flex-1 items-center gap-2 rounded-md border border-border-light bg-canvas-light px-3 py-1.5 text-sm text-muted-light dark:border-border-dark dark:bg-canvas-dark dark:text-muted-dark sm:flex">
        <Search size={15} />
        <span className="font-mono text-xs">Search…</span>
        <kbd className="ml-auto rounded border border-border-light px-1.5 py-0.5 font-mono text-[10px] dark:border-border-dark">
          ⌘K
        </kbd>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={toggle}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-light hover:bg-black/[.04] dark:text-muted-dark dark:hover:bg-white/[.06]"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        {/* Notifications placeholder */}
        <button
          className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-light hover:bg-black/[.04] dark:text-muted-dark dark:hover:bg-white/[.06]"
          aria-label="Notifications"
        >
          <Bell size={17} />
        </button>

        <div className="ml-1 h-6 w-px bg-border-light dark:bg-border-dark" />

        {/* Clerk's UserButton gives us avatar, dropdown, profile, and
            sign-out for free — no custom implementation needed. */}
        <UserButton afterSignOutUrl="/" />
      </div>
    </header>
  );
}
