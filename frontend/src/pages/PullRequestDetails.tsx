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
import { FindingCard, Finding } from "@/components/review/FindingCard";
import { FindingDiscussionDrawer } from "@/components/chat/FindingDiscussionDrawer";
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
  const [activeFinding, setActiveFinding] = useState<Finding | null>(null);

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

  const handleJumpToCode = (filePath: string) => {
    const element = document.getElementById(`diff-${filePath}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
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
    <div className="max-w-6xl mx-auto p-6 space-y-6 flex flex-col h-full min-h-screen relative">
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
              className="flex items-center gap-2 bg-signal-600 hover:bg-signal-700 text-white px-4 py-2 rounded-lg disabled:opacity-50 text-sm font-medium transition-colors shadow-sm"
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

          {/* --- UP-TO-DATE BADGE --- */}
          {latest && !isOutdated && (
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 px-3 py-1.5 rounded-md w-fit">
              <CheckCircle2 className="w-4 h-4" />
              AI Review is up to date with commit {latest.head_sha.slice(0, 7)}
            </div>
          )}

          {/* --- Latest AI Review Display --- */}
          {latest && (
            <Card
              className={`border ${isOutdated ? "border-amber-200 dark:border-amber-900 opacity-90" : "border-slate-200 dark:border-slate-800"}`}
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
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed text-sm">
                  {latest.summary}
                </p>

                {/* Modular Finding Cards with "Discuss with AI" actions */}
                <div className="space-y-4 mt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Findings ({latest.findings?.length || 0})
                    </h3>
                    <span className="text-xs text-slate-400">
                      Click &ldquo;Discuss with AI&rdquo; on any finding to ask questions
                    </span>
                  </div>

                  {latest.findings?.map((finding: any) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      isActive={activeFinding?.id === finding.id}
                      onDiscuss={(f) => setActiveFinding(f)}
                      onJumpToCode={handleJumpToCode}
                    />
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
                  id={`diff-${file.filename}`}
                  className="mb-4 border rounded-xl overflow-hidden border-gray-200 dark:border-gray-700"
                >
                  <div className="bg-gray-100 dark:bg-gray-800 p-2.5 text-xs font-mono font-semibold border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                    <span>{file.filename}</span>
                    <span className="text-slate-500 text-[11px]">
                      +{file.additions} / -{file.deletions}
                    </span>
                  </div>
                  <pre className="p-3.5 text-xs font-mono overflow-x-auto bg-slate-900 text-slate-100 leading-normal">
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

      {/* Scoped Finding Discussion Drawer */}
      <FindingDiscussionDrawer
        finding={activeFinding}
        isOpen={!!activeFinding}
        onClose={() => setActiveFinding(null)}
        repositoryId={repositoryId}
      />
    </div>
  );
}

