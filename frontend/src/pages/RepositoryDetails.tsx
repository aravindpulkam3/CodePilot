import { useState, useRef, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
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
  ArrowLeft,
  GitPullRequest,
  ExternalLink,
  Terminal,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useQueryClient } from "@tanstack/react-query";
import { sendChatMessageStream } from "@/services/api/repositoryApi";
import { useAuth } from "@clerk/clerk-react";
import { Button } from "@/components/ui/Button";
import { ChatInterface } from "@/components/chat/ChatInterface";

export default function RepositoryDetailsPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const navigate = useNavigate();

  const { data: repo, isLoading: isRepoLoading } = useRepositoryDetails(
    repositoryId!,
  );
  const { data: pulls = [], isLoading: isPullsLoading } =
    useRepositoryPullRequests(repositoryId!);

  const [activeTab, setActiveTab] = useState<"prs" | "chat" | "interview">(
    "prs",
  );
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  // Local state for the active stream so it updates instantly
  const [streamedText, setStreamedText] = useState("");
  const [streamedSources, setStreamedSources] = useState<any[]>([]);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState("");

  const { data: chatSessions = [] } = useChatSessions(repositoryId!, "QA");
  const { data: interviewSessions = [] } = useChatSessions(
    repositoryId!,
    "INTERVIEW",
  );
  const { data: history = [], isLoading: isHistoryLoading } =
    useChatHistory(activeSessionId);

  // console.log(history);
  console.log(interviewSessions, chatSessions);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, streamedText, optimisticUserMessage]);

  const handleSendMessage = async (msgToSend: string) => {
    if (!repositoryId || !msgToSend.trim() || isStreaming) return;
    console.log("handling send message", msgToSend);
    const userMessage = msgToSend;
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
              ? "border-signal-500 text-ink-light dark:text-ink-dark"
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
              ? "border-signal-500 text-ink-light dark:text-ink-dark"
              : "border-transparent text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark",
          )}
        >
          <Terminal className="h-4 w-4" /> Codebase Q&A
        </button>
        <button
          onClick={() => setActiveTab("interview")}
          className={cn(
            "pb-3 text-sm font-medium transition-colors border-b-2",
            activeTab === "interview"
              ? "border-signal-500 text-ink-light dark:text-ink-dark"
              : "border-transparent text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark",
          )}
        >
          Interview
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
      ) : activeTab === "chat" ? (
        <ChatInterface
          mode="QA"
          messages={history}
          isStreaming={isStreaming}
          streamedText={streamedText}
          streamedSources={streamedSources}
          onSendMessage={(msg) => {
            handleSendMessage(msg);
          }}
          isLoadingHistory={isHistoryLoading}
          showSidebar={true}
          sessions={chatSessions}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
          onNewSession={() => setActiveSessionId(null)}
          emptyStateMessage="Ask a question about the codebase to get started."
          placeholder="Ask a question about the codebase..."
        />
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <div className="flex justify-between items-center bg-slate-50 dark:bg-slate-900 border border-border-light dark:border-border-dark p-6 rounded-xl shadow-sm">
            <div>
              <h3 className="text-lg font-semibold text-ink-light dark:text-ink-dark">
                Preparation-focused Interviews
              </h3>
              <p className="text-sm text-muted-light">
                Run context-aware technical interviews to prepare yourself.
              </p>
            </div>
            <Button
              onClick={() =>
                navigate(`/repositories/${repositoryId}/interview`)
              }
              size="lg"
            >
              Start New Technical Interview
            </Button>
          </div>

          <div className="space-y-4">
            <h3 className="text-md font-semibold text-ink-light dark:text-ink-dark">
              Past Interviews
            </h3>

            {interviewSessions.length === 0 ? (
              <p className="text-sm text-muted-light">
                No past interview sessions found.
              </p>
            ) : (
              interviewSessions.map((s: any) => {
                const state =
                  typeof s.state === "string" ? JSON.parse(s.state) : s.state;
                const isCompleted = s.status === "completed";

                return (
                  <Card
                    key={s.id}
                    className="transition-colors hover:border-slate-300 dark:hover:border-slate-700"
                  >
                    <CardBody className="p-5 flex justify-between items-center">
                      <div>
                        <h4 className="font-semibold text-ink-light dark:text-ink-dark mb-1 capitalize">
                          {state?.currentTopic || "General"} Interview
                        </h4>
                        <div className="flex gap-4 text-xs text-muted-light">
                          <span>
                            {new Date(s.created_at).toLocaleDateString()}
                          </span>
                          <span className="capitalize text-signal-500">
                            Difficulty: {state?.difficulty}
                          </span>
                          {isCompleted ? (
                            <span className="text-green-600 font-medium">
                              Completed
                            </span>
                          ) : (
                            <span className="text-amber-500 font-medium">
                              In Progress
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-4 items-center">
                        {state?.assessment && (
                          <div className="text-right mr-4">
                            <span className="block text-xl font-bold text-signal-500">
                              {state.assessment.score}/10
                            </span>
                            <span className="text-xs text-muted-light">
                              Final Score
                            </span>
                          </div>
                        )}
                        <Button
                          variant="secondary"
                          onClick={() =>
                            navigate(
                              `/repositories/${repositoryId}/interview/${s.id}`,
                            )
                          }
                        >
                          {isCompleted ? "Review Transcript" : "Resume"}
                        </Button>
                      </div>
                    </CardBody>
                  </Card>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
