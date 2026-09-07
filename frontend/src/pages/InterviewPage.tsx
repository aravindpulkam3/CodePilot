// pages/InterviewPage.tsx
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useRepositoryDetails } from "@/hooks/useRepository";
import { apiClient } from "@/services/api/clientApi";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { SessionSidebar } from "@/components/chat/SessionSidebar";
import { useChatHistory, useChatSessions } from "@/hooks/useChat";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface InterviewConfig {
  difficulty: "easy" | "medium" | "hard" | "adaptive";
  domain: string;
  mode: "repository" | "general";
}

const DEFAULT_CONFIG: InterviewConfig = {
  difficulty: "medium",
  domain: "development",
  mode: "repository",
};

export function InterviewPage() {
  const { repositoryId, sessionId } = useParams<{ repositoryId: string, sessionId?: string }>();
  const navigate = useNavigate();

  const { data: repo, isLoading: repoLoading } = useRepositoryDetails(repositoryId!);
  const { data: interviewSessions = [] } = useChatSessions(repositoryId!, 'INTERVIEW');
  const { data: history = [], isLoading: historyLoading } = useChatHistory(sessionId || null);

  const [config, setConfig] = useState<InterviewConfig>(DEFAULT_CONFIG);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [isAnswering, setIsAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [isGeneratingInsights, setIsGeneratingInsights] = useState(false);
  const [assessment, setAssessment] = useState<any | null>(null);

  // Load existing session data if sessionId is provided
  useEffect(() => {
    if (sessionId) {
      if (history && history.length > 0) {
        setMessages(history.map((h: any) => ({
          role: h.role,
          content: h.content,
        })));
      }

      if (interviewSessions.length > 0) {
        const currentSession: any = interviewSessions.find((s: any) => s.id === sessionId);
        if (currentSession) {
          const state = typeof currentSession.state === 'string' ? JSON.parse(currentSession.state) : currentSession.state;
          if (currentSession.status === 'completed') {
            setIsComplete(true);
          }
          if (state && state.assessment) {
            setAssessment(state.assessment);
          }
        }
      }
    }
  }, [sessionId, history, interviewSessions]);

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

      // Navigate to the dynamic route
      navigate(`/repositories/${repositoryId}/interview/${data.sessionId}`);

    } catch (e) {
      console.error(e);
      setStartError("Could not start the interview. Please try again.");
    } finally {
      setIsStarting(false);
    }
  };

  const submitAnswer = async (userMsg: string) => {
    if (!userMsg.trim() || !sessionId || isAnswering || isComplete) return;

    setAnswerError(null);
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);

    setIsAnswering(true);
    try {
      const res = await apiClient.post(
        `/interview/${sessionId}/answer`,
        { answer: userMsg },
      );

      const data = res.data.data || res.data;

      if (data.nextQuestion || data.question) {
        // `nextQuestion` now holds the interviewer's full next spoken turn —
        // any correction is already woven into it conversationally by the
        // backend (see interview.service.ts / interviewPromptBuilder.ts), so
        // it's rendered as-is rather than having a separate feedback block
        // stapled in front of it.
        const rawNext = data.nextQuestion || data.question;
        const finalContent = typeof rawNext === "string" ? rawNext : JSON.stringify(rawNext);

        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: finalContent },
        ]);
      } else if (data.assessment) {
        const assessmentText = typeof data.assessment === "string" ? data.assessment : data.assessment.overallAssessment || JSON.stringify(data.assessment);
        setAssessment(data.assessment);
        setMessages((prev) => [...prev, { role: "assistant", content: `Interview complete.\n\n${assessmentText}` }]);
        setIsComplete(true);
      }
    } catch (e) {
      console.error(e);
      setAnswerError("Something went wrong sending your answer. Please try again.");
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsAnswering(false);
    }
  };

  const endInterview = async () => {
    if (!sessionId || isComplete) return;
    setIsEnding(true);
    try {
      await apiClient.post(`/interview/${sessionId}/end`);
      setIsComplete(true);
      setMessages((prev) => [...prev, { role: "assistant", content: "You have manually ended the interview." }]);
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
      const res = await apiClient.post(`/interview/${sessionId}/insights`);
      const data = res.data.data || res.data;
      setAssessment(data);
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
                <div className="grid grid-cols-2 gap-4">
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
                  <div>
                    <label className="block text-sm mb-1 text-muted-light dark:text-muted-dark">Domain</label>
                    <select
                      className="w-full rounded-md border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark px-3 py-2 text-sm text-ink-light dark:text-ink-dark"
                      value={config.domain}
                      onChange={(e) =>
                        setConfig({ ...config, domain: e.target.value })
                      }
                    >
                      <option value="development">Development</option>
                      <option value="system-design">System Design</option>
                      <option value="debugging">Debugging</option>
                    </select>
                  </div>
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
            messages={messages}
            isStreaming={isAnswering}
            isLoadingHistory={historyLoading}
            onSendMessage={(msg) => submitAnswer(msg)}
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
