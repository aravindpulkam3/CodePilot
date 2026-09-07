import { MessageSquare, Plus } from "lucide-react";
import { cn } from "@/utils/cn";

interface SessionSidebarProps {
  sessions: any[];
  activeSessionId?: string | null;
  onSelectSession?: (id: string | null) => void;
  onNewSession?: () => void;
  newLabel?: string;
}

/**
 * Session list + "new session" action, shared by ChatInterface (Q&A,
 * Interview, Review) and InterviewPage's landing/config screen — extracted
 * so both can browse past sessions with identical behavior.
 */
export function SessionSidebar({
  sessions,
  activeSessionId = null,
  onSelectSession,
  onNewSession,
  newLabel = "New Chat",
}: SessionSidebarProps) {
  return (
    <div className="w-64 border-r border-border-light dark:border-border-dark bg-slate-50 dark:bg-slate-900/50 flex flex-col shrink-0">
      <div className="p-4 border-b border-border-light dark:border-border-dark">
        <button
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-signal-500 px-3 py-2 text-sm font-medium text-white hover:bg-signal-600 transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" /> {newLabel}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-light dark:text-muted-dark">
            No conversations yet.
          </p>
        ) : (
          sessions.map((session: any) => (
            <button
              key={session.id}
              onClick={() => onSelectSession?.(session.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors truncate",
                activeSessionId === session.id
                  ? "bg-white dark:bg-slate-800 text-ink-light dark:text-ink-dark shadow-sm ring-1 ring-border-light dark:ring-border-dark"
                  : "text-muted-light dark:text-muted-dark hover:bg-white/50 dark:hover:bg-slate-800/50",
              )}
            >
              <MessageSquare className="h-4 w-4 shrink-0" />
              <span className="truncate">
                Chat {new Date(session.created_at).toLocaleDateString()}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
