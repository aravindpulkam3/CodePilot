// pages/InterviewPage.tsx
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useRepositoryDetails } from "@/hooks/useRepository";
import { apiClient } from "@/services/api/clientApi";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { SessionSidebar } from "@/components/chat/SessionSidebar";
import { useChatHistory, useChatSessions } from "@/hooks/useChat";

interface InterviewConfig {
  difficulty: "easy" | "medium" | "hard" | "adaptive";
  mode: "repository" | "general";
}

const DEFAULT_CONFIG: InterviewConfig = {
  difficulty: "medium",
  mode: "repository",
};

interface InterviewAssessment {
  overallAssessment: string;
  strengths: string[];
  weaknesses: string[];
  score: number;
}

/** The parts of a session-list row this page reads. */
interface InterviewSessionRow {
  id: string;
  status?: string;
  state?: unknown;
}

function assessmentOf(session: InterviewSessionRow | undefined): InterviewAssessment | null {
  const state = typeof session?.state === "string" ? JSON.parse(session.state) : session?.state;
  return (state as { assessment?: InterviewAssessment } | undefined)?.assessment ?? null;
}

/**
 * One instance per interview (keyed by session id), so in-flight flags, errors
 * and ChatInterface's unsent draft can never carry over into another
 * interview. Server state — messages, completion, assessment — is read from
 * the queries, never copied into local state.
 */
export function InterviewPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  return <InterviewSession key={sessionId ?? "new"} />;
}

function InterviewSession() {
  const { repositoryId, sessionId } = useParams<{ repositoryId: string, sessionId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: repo, isLoading: repoLoading } = useRepositoryDetails(repositoryId!);
  const { data: interviewSessions = [], isLoading: sessionsLoading } = useChatSessions(repositoryId!, 'INTERVIEW');
  const { data: history = [], isLoading: historyLoading } = useChatHistory(sessionId || null);

  const [config, setConfig] = useState<InterviewConfig>(DEFAULT_CONFIG);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [isAnswering, setIsAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [isEnding, setIsEnding] = useState(false);
  const [isGeneratingInsights, setIsGeneratingInsights] = useState(false);

  // Derived from the session list, so they always describe THIS session.
  const sessions: InterviewSessionRow[] = interviewSessions;
  const currentSession = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const isComplete = currentSession?.status === "completed";
  const assessment = assessmentOf(currentSession);

  const sessionsKey = ["chatSessions", repositoryId, "INTERVIEW"];
  const historyKey = ["chatHistory", sessionId];

  const startInterview = async () => {
    if (!repositoryId) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const res = await apiClient.post("/interview/start", {
        config: {
          ...config,
          repositoryId,
          followUpsEnabled: true,
        },
      });

      // Safety net for Axios data wrapping
      const data = res.data.data || res.data;

      // The new interview belongs in the sidebar (and the overview's count).
      void queryClient.invalidateQueries({ queryKey: sessionsKey });

      // Navigate to the dynamic route
      navigate(`/repositories/${repositoryId}/interview/${data.sessionId}`);

    } catch (e) {
      console.error(e);
      setStartError("Could not start the interview. Please try again.");
    } finally {
      setIsStarting(false);
    }
  };

  /** Resolves false when the answer wasn't sent, so ChatInterface gives the text back. */
  const submitAnswer = async (answer: string): Promise<boolean> => {
    if (!answer.trim() || !sessionId || isAnswering || isComplete) return false;

    setAnswerError(null);
    setIsAnswering(true);
    try {
      await apiClient.post(`/interview/${sessionId}/answer`, { answer });
      // The server saved the answer and the next question together; show both.
      await queryClient.invalidateQueries({ queryKey: historyKey });
      return true;
    } catch (e) {
      console.error(e);
      setAnswerError("Your answer wasn't sent — it's back in the box so you can retry.");
      // Resync with the server: the interview may have ended, or this
      // question may already have been answered elsewhere (409).
      void queryClient.invalidateQueries({ queryKey: historyKey });
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
      return false;
    } finally {
      setIsAnswering(false);
    }
  };

  const endInterview = async () => {
    if (!sessionId || isComplete) return;
    setIsEnding(true);
    try {
      await apiClient.post(`/interview/${sessionId}/end`);
      // Completion is read from the session list.
      await queryClient.invalidateQueries({ queryKey: sessionsKey });
    } catch (error) {
      console.error(error);
      setAnswerError("Failed to end interview.");
    } finally {
      setIsEnding(false);
    }
  };

  const generateInsights = async () => {
    if (!sessionId || !isComplete) return;
    setIsGeneratingInsights(true);
    try {
      await apiClient.post(`/interview/${sessionId}/insights`);
      // The assessment is stored in the session's state, read from the list.
      await queryClient.invalidateQueries({ queryKey: sessionsKey });
    } catch (error) {
      console.error(error);
      setAnswerError("Failed to generate insights.");
    } finally {
      setIsGeneratingInsights(false);
    }
  };

  // ---- Landing / config screen (no active session) ----
  if (!sessionId) {
    return (
      <div className="flex h-full min-h-0 gap-4">
        <SessionSidebar
          sessions={interviewSessions}
          activeSessionId={null}
          onSelectSession={(id) => id && navigate(`/repositories/${repositoryId}/interview/${id}`)}
          onNewSession={() => setConfig(DEFAULT_CONFIG)}
          newLabel="New Interview"
        />
        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-md">
            {repoLoading ? (
              <div className="mb-6 h-4 w-72 animate-pulse rounded bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark" />
            ) : repo ? (
              <p className="mb-6 text-sm text-muted-light dark:text-muted-dark">
                Practice a technical interview grounded in {repo.name}'s
                architecture and code.
              </p>
            ) : null}

            <Card>
              <CardHeader>
                <h2 className="text-sm font-semibold text-ink-light dark:text-ink-dark">
                  Start a new interview
                </h2>
              </CardHeader>
              <CardBody className="space-y-4">
                <div>
                  <label className="block text-sm mb-1 text-muted-light dark:text-muted-dark">Difficulty</label>
                  <select
                    className="w-full rounded-md border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark px-3 py-2 text-sm text-ink-light dark:text-ink-dark"
                    value={config.difficulty}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        difficulty: e.target
                          .value as InterviewConfig["difficulty"],
                      })
                    }
                  >
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                    <option value="adaptive">Adaptive</option>
                  </select>
                </div>
                {startError && (
                  <p className="text-sm text-red-500">{startError}</p>
                )}
                <Button
                  className="w-full"
                  onClick={startInterview}
                  disabled={isStarting || repoLoading}
                  isLoading={isStarting}
                >
                  {isStarting ? "Starting..." : "Start Interview"}
                </Button>
              </CardBody>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // ---- Active session screen ----
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={isComplete ? "neutral" : "signal"}>
            {isComplete ? "Complete" : "In progress"}
          </Badge>
          {answerError && (
            <span className="text-sm text-red-500">{answerError}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isComplete && (
            <Button variant="danger" size="sm" onClick={endInterview} disabled={isEnding || isAnswering}>
              {isEnding ? "Ending..." : "End Interview"}
            </Button>
          )}
          {isComplete && !assessment && (
            <Button size="sm" onClick={generateInsights} disabled={isGeneratingInsights}>
              {isGeneratingInsights ? "Generating Insights..." : "Generate AI Insights"}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 gap-4">
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatInterface
            mode="INTERVIEW"
            messages={history}
            isStreaming={isAnswering}
            isLoadingHistory={historyLoading}
            onSendMessage={submitAnswer}
            // Until the session list loads, completion is unknown.
            disabled={isComplete || isEnding || sessionsLoading}
            showSidebar={true}
            sessions={interviewSessions}
            activeSessionId={sessionId}
            onSelectSession={(id) =>
              navigate(id ? `/repositories/${repositoryId}/interview/${id}` : `/repositories/${repositoryId}/interview`)
            }
            onNewSession={() => navigate(`/repositories/${repositoryId}/interview`)}
            emptyStateMessage="Interview started. Waiting for question..."
            placeholder={
              isComplete ? "Interview complete" : "Type your answer..."
            }
          />
        </div>

        {assessment && (
          <div className="w-1/3 min-w-[300px] overflow-y-auto">
            <Card>
              <CardBody className="p-5 space-y-4">
                <h3 className="text-xl font-bold">Interview Assessment</h3>
                <div className="text-4xl font-bold text-signal-500">{assessment.score}<span className="text-lg text-muted-light">/10</span></div>

                <div>
                  <h4 className="font-semibold text-ink-light dark:text-ink-dark mb-1">Overall Assessment</h4>
                  <p className="text-sm text-slate-700 dark:text-slate-300">{assessment.overallAssessment}</p>
                </div>

                {assessment.strengths && assessment.strengths.length > 0 && (
                  <div className="border-l-4 border-emerald-500 pl-3">
                    <h4 className="font-semibold text-emerald-600 dark:text-emerald-400 mb-1">Strengths</h4>
                    <ul className="list-disc pl-5 text-sm text-slate-700 dark:text-slate-300">
                      {assessment.strengths.map((s: string, i: number) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}

                {assessment.weaknesses && assessment.weaknesses.length > 0 && (
                  <div className="border-l-4 border-rose-500 pl-3">
                    <h4 className="font-semibold text-rose-600 dark:text-rose-400 mb-1">Areas for Improvement</h4>
                    <ul className="list-disc pl-5 text-sm text-slate-700 dark:text-slate-300">
                      {assessment.weaknesses.map((w: string, i: number) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </CardBody>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
