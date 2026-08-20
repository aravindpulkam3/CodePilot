import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { usePullRequestDetail } from "@/hooks/useRepository";
import { useTriggerAiReview, usePullRequestReviews } from "@/hooks/useReview";
import { useChatSessions, useChatHistory } from "@/hooks/useChat";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import {
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Terminal,
  List,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { useAuth } from "@clerk/clerk-react";
import { useQueryClient } from "@tanstack/react-query";
import { sendChatMessageStream } from "@/services/api/repositoryApi";

export default function PullRequestDetailsPage() {
  const { repositoryId, pullNumber } = useParams<{
    repositoryId: string;
    pullNumber: string;
  }>();
  const [activeTab, setActiveTab] = useState<"findings" | "chat">("findings");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  // Chat states
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [streamedSources, setStreamedSources] = useState<any[]>([]);

  // 1. Fetch GitHub PR Details
  const { data: pr, isLoading: isPrLoading } = usePullRequestDetail(
    repositoryId!,
    pullNumber!,
  );

  // 2. Fetch Existing AI Reviews
  const { data: reviewData, isLoading: isReviewsLoading } =
    usePullRequestReviews(repositoryId!, pullNumber!);

  // 3. AI Generation Mutation
  const { mutate: generateReview, isPending: isGenerating } =
    useTriggerAiReview();

  // 4. Chat Data
  const { data: sessions = [] } = useChatSessions(repositoryId!, "REVIEW");
  const { data: history = [], isLoading: isHistoryLoading } =
    useChatHistory(activeSessionId);

  const handleSendMessage = async (userMessage: string) => {
    if (!repositoryId || !userMessage.trim() || isStreaming) return;

    setStreamedText("");
    setStreamedSources([]);
    setIsStreaming(true);

    const token = await getToken();
    if (!token) throw new Error("No token available");

    let resolvedSessionId = activeSessionId;

    try {
      // NOTE: We may need to pass pullNumber to the backend in the future so it knows which PR to review
      const response = await sendChatMessageStream(
        repositoryId,
        userMessage,
        resolvedSessionId,
        token,
        "REVIEW",
      );
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

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
                resolvedSessionId = payload.data;
                setActiveSessionId(payload.data);
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

      await queryClient.invalidateQueries({
        queryKey: ["chatHistory", resolvedSessionId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["chatSessions", repositoryId, "REVIEW"],
      });
    } catch (error) {
      console.error("Chat error:", error);
    } finally {
      setIsStreaming(false);
      setStreamedText("");
      setStreamedSources([]);
    }
  };

  if (isPrLoading || isReviewsLoading)
    return <div className="p-8">Loading PR details...</div>;
  if (!pr) return <div className="p-8">Pull Request not found.</div>;

  const { latest, history: reviewHistory } = reviewData || {
    latest: null,
    history: [],
  };

  // 🎯 STALENESS CHECK: Compare current commit SHA vs reviewed commit SHA
  const isOutdated = !!latest && pr.head_sha !== latest.head_sha;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6 flex flex-col h-full min-h-screen">
      <div>
        <Link
          to={`/repositories/${repositoryId}`}
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Repository
        </Link>
        <PageHeader
          title={`#${pr.number} ${pr.title}`}
          description={`Opened by ${pr.author?.login} • ${pr.changed_files_count} files changed`}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-6 border-b border-border-light dark:border-border-dark flex-1">
          <button
            onClick={() => setActiveTab("findings")}
            className={cn(
              "pb-3 text-sm font-medium flex items-center gap-2 transition-colors border-b-2",
              activeTab === "findings"
                ? "border-signal-500 text-ink-light dark:text-ink-dark"
                : "border-transparent text-muted-light hover:text-ink-light dark:text-muted-dark dark:hover:text-ink-dark",
            )}
          >
            <List className="h-4 w-4" /> AI Findings
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
            <Terminal className="h-4 w-4" /> Review Q&A
          </button>
        </div>
      </div>

      {activeTab === "findings" ? (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <div className="text-xs text-gray-500 font-mono">
              Current Commit:{" "}
              <span className="font-bold text-gray-700 dark:text-gray-300">
                {pr.head_sha.slice(0, 7)}
              </span>
            </div>
            <button
              onClick={() =>
                generateReview({
                  repositoryId: repositoryId!,
                  pullNumber: Number(pullNumber),
                })
              }
              disabled={isGenerating}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50 text-sm font-medium transition-colors"
            >
              <RefreshCw
                className={`w-4 h-4 ${isGenerating ? "animate-spin" : ""}`}
              />
              {isGenerating
                ? "Analyzing Code..."
                : isOutdated
                  ? "Re-analyze New Commits"
                  : latest
                    ? "Re-run AI Review"
                    : "Generate AI Review"}
            </button>
          </div>

          {/* ⚠️ OUTDATED REVIEW ALERT BANNER */}
          {isOutdated && (
            <div className="flex items-start gap-3 p-4 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">
                <p className="font-semibold">
                  Code has changed since the last AI review
                </p>
                <p className="mt-0.5 opacity-90">
                  New commits were pushed to this branch after this review was
                  generated for commit{" "}
                  <code className="font-mono bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 rounded text-xs">
                    {latest.head_sha.slice(0, 7)}
                  </code>
                  . Click above to generate a fresh review.
                </p>
              </div>
            </div>
          )}

          {/* --- UP-TO-DATE BADGE (Optional indicator when review matches head_sha) --- */}
          {latest && !isOutdated && (
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 px-3 py-1.5 rounded-md w-fit">
              <CheckCircle2 className="w-4 h-4" />
              AI Review is up to date with commit {latest.head_sha.slice(0, 7)}
            </div>
          )}

          {/* --- Latest AI Review Display --- */}
          {latest && (
            <Card
              className={`border ${isOutdated ? "border-amber-200 dark:border-amber-900 opacity-90" : "border-blue-200 dark:border-blue-900"}`}
            >
              <CardHeader>
                <div className="flex justify-between items-center">
                  <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                    AI Review Score: {latest.overall_score}/100
                  </h2>
                  {isOutdated && (
                    <span className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 font-bold px-2.5 py-1 rounded-full uppercase">
                      Outdated
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Reviewed on {new Date(latest.created_at).toLocaleString()} •
                  Commit: {latest.head_sha.slice(0, 7)}
                </p>
              </CardHeader>
              <CardBody className="space-y-4">
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                  {latest.summary}
                </p>

                {/* Inline Findings */}
                <div className="space-y-3 mt-4">
                  {latest.findings?.map((finding: any) => (
                    <div
                      key={finding.id}
                      className="p-3.5 border rounded-lg bg-white dark:bg-slate-800 border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span
                          className={`text-xs font-bold uppercase tracking-wider ${
                            finding.category === "security"
                              ? "text-red-500"
                              : finding.category === "correctness"
                                ? "text-amber-600"
                                : "text-blue-500"
                          }`}
                        >
                          {finding.category} • {finding.severity}
                        </span>
                      </div>
                      <p className="font-semibold text-sm text-gray-900 dark:text-gray-100">
                        {finding.title}
                      </p>
                      <p className="text-xs font-mono text-gray-500 mt-0.5">
                        {finding.file_path}:{finding.line_number}
                      </p>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mt-2">
                        {finding.description}
                      </p>
                      {finding.code_suggestion && (
                        <pre className="mt-2.5 bg-gray-900 text-gray-100 p-3 text-xs rounded-md overflow-x-auto font-mono">
                          <code>{finding.code_suggestion}</code>
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}

          {/* --- Code Diff Viewer --- */}
          <Card>
            <CardHeader>
              <h3 className="font-bold">Code Changes</h3>
            </CardHeader>
            <CardBody>
              {pr.files?.map((file: any) => (
                <div
                  key={file.filename}
                  className="mb-4 border rounded overflow-hidden border-gray-200 dark:border-gray-700"
                >
                  <div className="bg-gray-100 dark:bg-gray-800 p-2 text-xs font-mono font-semibold border-b border-gray-200 dark:border-gray-700">
                    {file.filename}
                  </div>
                  <pre className="p-3 text-xs font-mono overflow-x-auto bg-slate-900 text-slate-100 leading-normal">
                    {file.patch}
                  </pre>
                </div>
              ))}
            </CardBody>
          </Card>

          {/* --- Review History List --- */}
          {reviewHistory && reviewHistory.length > 0 && (
            <div className="mt-8 space-y-3">
              <h3 className="text-lg font-bold text-gray-800 dark:text-gray-200">
                Review History
              </h3>
              <div className="space-y-2">
                {reviewHistory.map((hist: any) => (
                  <Card
                    key={hist.id}
                    className="opacity-75 hover:opacity-100 transition-opacity"
                  >
                    <CardBody className="flex justify-between items-center py-3">
                      <div>
                        <span className="font-bold text-sm">
                          Score: {hist.overall_score}/100
                        </span>
                        <p className="text-xs text-gray-500 font-mono">
                          {new Date(hist.created_at).toLocaleString()} • Commit:{" "}
                          {hist.head_sha.slice(0, 7)}
                        </p>
                      </div>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-hidden pb-6">
          <ChatInterface
            mode="REVIEW"
            messages={history}
            isStreaming={isStreaming}
            streamedText={streamedText}
            streamedSources={streamedSources}
            onSendMessage={handleSendMessage}
            isLoadingHistory={isHistoryLoading}
            showSidebar={true}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={setActiveSessionId}
            onNewSession={() => setActiveSessionId(null)}
            emptyStateMessage="Ask a question about this Pull Request to get started."
            placeholder="Ask about these changes..."
          />
        </div>
      )}
    </div>
  );
}
