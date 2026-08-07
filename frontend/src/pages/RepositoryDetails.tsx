import { useState, useRef, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import {
  useRepositoryDetails,
  useRepositoryPullRequests,
} from "@/hooks/useRepository";
import { useChatSessions, useChatHistory } from "@/hooks/useChat";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import {
  Lock,
  Globe,
  GitBranch,
  GitPullRequest,
  ArrowLeft,
  ExternalLink,
  MessageSquare,
  Plus,
  Send,
  Code,
  Terminal,
  User,
  Bot,
  Loader2,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useQueryClient } from "@tanstack/react-query";
import { sendChatMessageStream } from "@/services/api/repositoryApi";
import { useAuth } from "@clerk/clerk-react";

// The chat-history endpoint has been seen to send the sender under different
// keys/casing depending on which layer produced the row (e.g. "user" vs
// "human", or "role" vs "type"). Normalizing here means the UI keeps working
// even if that shape drifts, instead of silently dropping user turns.
function isUserMessage(msg: any): boolean {
  return msg?.role?.trim().toLowerCase() === "user";
}

export default function RepositoryDetailsPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  const { data: repo, isLoading: isRepoLoading } = useRepositoryDetails(
    repositoryId!,
  );
  const { data: pulls = [], isLoading: isPullsLoading } =
    useRepositoryPullRequests(repositoryId!);

  const [activeTab, setActiveTab] = useState<"prs" | "chat">("prs");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  // Local state for the active stream so it updates instantly
  const [streamedText, setStreamedText] = useState("");
  const [streamedSources, setStreamedSources] = useState<any[]>([]);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState("");

  const { data: sessions = [] } = useChatSessions(repositoryId!);
  const { data: history = [], isLoading: isHistoryLoading } =
    useChatHistory(activeSessionId);

  console.log(history);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, streamedText, optimisticUserMessage]);

  const handleSendMessage = async () => {
    if (!repositoryId || !input.trim() || isStreaming) return;

    const userMessage = input;
    setInput("");
    setOptimisticUserMessage(userMessage);
    setStreamedText("");
    setStreamedSources([]);
    setIsStreaming(true);

    const token = await getToken();
    if (!token) throw new Error("No token available");

    // We keep track of the session ID inside this function block
    // so the query invalidation at the end works correctly.
    let resolvedSessionId = activeSessionId;

    try {
      const response = await sendChatMessageStream(
        repositoryId,
        userMessage,
        resolvedSessionId,
        token,
      );
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader(); // Taps into the raw byte stream
      const decoder = new TextDecoder(); // Prepares a translator (Bytes -> Strings)

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const jsonStr = line.replace("data: ", "");
            try {
              const payload = JSON.parse(jsonStr);

              if (payload.type === "sessionId") {
                resolvedSessionId = payload.data; // Update local variable
                setActiveSessionId(payload.data); // Update React state
              } else if (payload.type === "sources") {
                setStreamedSources(payload.data);
              } else if (payload.type === "text") {
                setStreamedText((prev) => prev + payload.data);
              }
            } catch (e) {
              console.error("Failed to parse chunk", e);
            }
          }
        }
      }

      // We use `resolvedSessionId` here instead of `activeSessionId` because
      // the React state might not have fully batched and updated yet.
      await queryClient.invalidateQueries({
        queryKey: ["chatHistory", resolvedSessionId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["chatSessions", repositoryId],
      });
    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsStreaming(false);
      setOptimisticUserMessage("");
      setStreamedText("");
      setStreamedSources([]);
    }
  };

  if (isRepoLoading)
    return (
      <div className="py-12 text-center text-sm text-muted-light dark:text-muted-dark">
        Loading repository details...
      </div>
    );
  if (!repo)
    return (
      <div className="py-12 text-center text-sm text-red-500">
        Repository not found.
      </div>
    );

  return (
    <div className="space-y-8 animate-in fade-in duration-500 h-full flex flex-col">
      <div>
        <Link
          to="/dashboard"
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Dashboard
        </Link>
        <PageHeader
          title={repo.name}
          description={repo.description || "No description provided."}
        />
      </div>

      {/* Metadata Card */}
      <Card>
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">
              Visibility
            </span>
            <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-light dark:text-ink-dark">
              {repo.is_private ? (
                <Lock className="h-4 w-4" />
              ) : (
                <Globe className="h-4 w-4" />
              )}
              {repo.is_private ? "Private" : "Public"}
            </div>
          </div>
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">
              Language
            </span>
            <p className="mt-1 text-sm font-medium text-ink-light dark:text-ink-dark">
              {repo.language || "N/A"}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">
              Default Branch
            </span>
            <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-light dark:text-ink-dark">
              <GitBranch className="h-4 w-4" />
              {repo.default_branch}
            </div>
          </div>
          <div>
            <span className="text-xs text-muted-light dark:text-muted-dark">
              Last Pushed
            </span>
            <p className="mt-1 text-sm font-medium text-ink-light dark:text-ink-dark">
              {repo.last_pushed_at
                ? new Date(repo.last_pushed_at).toLocaleDateString()
                : "N/A"}
            </p>
          </div>
        </CardBody>
      </Card>

      {/* Tabs */}
      <div className="flex items-center gap-6 border-b border-border-light dark:border-border-dark">
        <button
          onClick={() => setActiveTab("prs")}
          className={cn(
            "pb-3 text-sm font-medium transition-colors border-b-2",
            activeTab === "prs"
              ? "border-brand-500 text-ink-light dark:text-ink-dark"
              : "border-transparent text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark",
          )}
        >
          Pull Requests
        </button>
        <button
          onClick={() => setActiveTab("chat")}
          className={cn(
            "pb-3 text-sm font-medium flex items-center gap-2 transition-colors border-b-2",
            activeTab === "chat"
              ? "border-brand-500 text-ink-light dark:text-ink-dark"
              : "border-transparent text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark",
          )}
        >
          <Terminal className="h-4 w-4" /> Codebase Q&A
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "prs" ? (
        <div className="space-y-3">
          {isPullsLoading ? (
            <div className="py-12 text-center text-sm text-muted-light">
              Loading pull requests...
            </div>
          ) : pulls.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-light">
              No pull requests found.
            </div>
          ) : (
            pulls.map((pr) => (
              <Link
                key={pr.number}
                to={`/repositories/${repositoryId}/pulls/${pr.number}`}
              >
                <Card className="transition-colors hover:border-slate-300 dark:hover:border-slate-700">
                  <CardBody className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <GitPullRequest
                        className={cn(
                          "h-5 w-5",
                          pr.state === "open"
                            ? "text-green-500"
                            : !!pr.merged_at
                              ? "text-purple-500"
                              : "text-red-500",
                        )}
                      />
                      <div>
                        <h4 className="text-base font-medium">
                          #{pr.number} {pr.title}
                        </h4>
                      </div>
                    </div>
                    <ExternalLink className="h-4 w-4 text-muted-light" />
                  </CardBody>
                </Card>
              </Link>
            ))
          )}
        </div>
      ) : (
        /* Codebase Q&A Interface */
        <Card className="flex h-[600px] overflow-hidden">
          {/* Chat Sidebar */}
          <div className="w-64 border-r border-border-light dark:border-border-dark bg-slate-50 dark:bg-slate-900/50 flex flex-col">
            <div className="p-4 border-b border-border-light dark:border-border-dark">
              <button
                onClick={() => setActiveSessionId(null)}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors"
              >
                <Plus className="h-4 w-4" /> New Chat
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
                    onClick={() => setActiveSessionId(session.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors truncate",
                      activeSessionId === session.id
                        ? "bg-slate-200 dark:bg-slate-800 text-ink-light dark:text-ink-dark"
                        : "text-muted-light dark:text-muted-dark hover:bg-slate-100 dark:hover:bg-slate-800/50",
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

          {/* Chat Main Area */}
          <div className="flex-1 flex flex-col">
            <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-white dark:bg-slate-950">
              {isHistoryLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-light dark:text-muted-dark">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading
                  conversation...
                </div>
              ) : history.length === 0 &&
                !optimisticUserMessage &&
                !isStreaming ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-light dark:text-muted-dark">
                  Ask a question about the codebase to get started.
                </div>
              ) : (
                history.map((msg: any, idx: number) => {
                  const fromUser = isUserMessage(msg);
                  console.log(msg.role, fromUser);
                  return (
                    <div
                      key={msg.id ?? idx}
                      className={cn(
                        "flex items-end gap-2",
                        fromUser ? "justify-end" : "justify-start",
                      )}
                    >
                      {!fromUser && (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 dark:bg-slate-800 text-muted-light dark:text-muted-dark">
                          <Bot className="h-4 w-4" />
                        </div>
                      )}
                      <div
                        className={cn(
                          "max-w-[80%] rounded-xl px-4 py-3 text-sm shadow-sm",
                          fromUser
                            ? "bg-blue-500 text-white"
                            : "bg-slate-100 text-black",
                        )}
                      >
                        <div className="whitespace-pre-wrap">
                          <strong>{msg.role}</strong>
                          <br />
                          {msg.content}
                        </div>
                      </div>
                      {fromUser && (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-500/20 text-brand-600 dark:text-brand-400">
                          <User className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* Optimistic User Message */}
              {optimisticUserMessage && (
                <div className="flex items-end justify-end gap-2">
                  <div className="max-w-[80%] rounded-xl bg-brand-500 px-4 py-3 text-sm text-white shadow-sm">
                    {optimisticUserMessage}
                  </div>
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-500/20 text-brand-600 dark:text-brand-400">
                    <User className="h-4 w-4" />
                  </div>
                </div>
              )}

              {/* Streaming Assistant Response */}
              {(isStreaming || streamedText) && (
                <div className="flex items-end justify-start gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 dark:bg-slate-800 text-muted-light dark:text-muted-dark">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="max-w-[80%] rounded-xl bg-slate-100 dark:bg-slate-900 px-4 py-3 text-sm text-ink-light dark:text-ink-dark shadow-sm">
                    {/* Render Sources First */}
                    {streamedSources.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {streamedSources.map((source, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs"
                          >
                            <Code className="h-3 w-3 text-brand-500" />
                            <span className="font-mono text-muted-light dark:text-muted-dark">
                              {source.file_path.split("/").pop()}
                            </span>
                            <span className="text-[10px] text-slate-400">
                              L{source.start_line}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Render Streaming Text */}
                    <div className="whitespace-pre-wrap">{streamedText}</div>
                    {isStreaming && (
                      <span className="inline-block w-1.5 h-4 ml-1 bg-brand-500 animate-pulse" />
                    )}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 border-t border-border-light dark:border-border-dark bg-slate-50 dark:bg-slate-900/50">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendMessage();
                }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask a question about the codebase..."
                  className="flex-1 rounded-md border border-border-light dark:border-border-dark bg-white dark:bg-slate-950 px-4 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  disabled={isStreaming}
                />
                <button
                  type="submit"
                  disabled={isStreaming || !input.trim()}
                  className="flex items-center justify-center rounded-md bg-brand-500 px-4 py-2 text-white hover:bg-brand-600 disabled:opacity-50 transition-colors"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
