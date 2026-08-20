// pages/InterviewPage.tsx
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { useRepositoryDetails } from "@/hooks/useRepository";
import { apiClient } from "@/services/api/clientApi";
import { ChatInterface } from "@/components/chat/ChatInterface";
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

export function InterviewPage() {
  const { repositoryId, sessionId } = useParams<{ repositoryId: string, sessionId?: string }>();
  const navigate = useNavigate();

  const { data: repo, isLoading: repoLoading } = useRepositoryDetails(repositoryId!);
  const { data: interviewSessions = [] } = useChatSessions(repositoryId!, 'INTERVIEW');
  const { data: history = [], isLoading: historyLoading } = useChatHistory(sessionId || null);

  const [config, setConfig] = useState<InterviewConfig>({
    difficulty: "medium",
    domain: "development",
    mode: "repository",
  });
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
      console.log("Interview Started Payload:", data);

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
        const rawNext = data.nextQuestion || data.question;
        const safeNext = typeof rawNext === "string" ? rawNext : JSON.stringify(rawNext);
        let finalContent = safeNext;

        // If the AI returned corrective feedback, prepend it to the next question
        if (data.correction && data.correction.needed) {
           finalContent = `**Corrective Feedback:**\n${data.correction.explanation}\n\n**Key Points:**\n${data.correction.keyPoints.map((kp: string) => `- ${kp}`).join('\n')}\n\n---\n\n${safeNext}`;
        }

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

  const header = (
    <div className="mb-6 shrink-0">
      <button
        onClick={() => navigate(-1)}
        className="text-sm text-muted-light hover:text-ink-light mb-4 inline-flex items-center gap-1"
      >
        ← Back to repository
      </button>
      {repoLoading ? (
        <div className="h-8 w-64 rounded bg-surface-light dark:bg-surface-dark animate-pulse border border-border-light dark:border-border-dark" />
      ) : repo ? (
        <PageHeader
          title={`Technical Interview: ${repo.name}`}
          description={
            repo.description ||
            "Interactive technical interview based on repository context"
          }
        />
      ) : null}

      {sessionId && !isComplete && (
        <div className="mt-4 flex justify-end">
          <Button variant="danger" onClick={endInterview} disabled={isEnding || isAnswering}>
            {isEnding ? "Ending..." : "End Interview"}
          </Button>
        </div>
      )}
      
      {sessionId && isComplete && !assessment && (
        <div className="mt-4 flex justify-end">
          <Button onClick={generateInsights} disabled={isGeneratingInsights}>
            {isGeneratingInsights ? "Generating Insights..." : "Generate AI Insights"}
          </Button>
        </div>
      )}
    </div>
  );

  if (!sessionId) {
    return (
      <div className="max-w-4xl mx-auto py-10 px-4">
        {header}
        <Card>
          <CardBody className="p-6">
            <h2 className="text-lg font-semibold mb-1">
              Start Technical Interview
            </h2>
            <p className="text-sm text-muted-light mb-6">
              We'll ask questions grounded in this repository's architecture and
              code.
            </p>
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm mb-1">Difficulty</label>
                <select
                  className="w-full rounded-md border border-border-light bg-surface-light px-3 py-2 text-sm text-ink-light"
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
                <label className="block text-sm mb-1">Domain</label>
                <select
                  className="w-full rounded-md border border-border-light bg-surface-light px-3 py-2 text-sm text-ink-light"
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
              {startError && (
                <p className="text-sm text-red-500">{startError}</p>
              )}
              <Button
                onClick={startInterview}
                disabled={isStarting || repoLoading}
              >
                {isStarting ? "Starting..." : "Start Interview"}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto py-10 px-4 flex flex-col h-[calc(100vh-4rem)]">
      {header}
      {answerError && (
        <p className="text-sm text-red-500 mb-2 shrink-0">{answerError}</p>
      )}
      <div className="flex-1 overflow-hidden min-h-0 flex gap-4">
        <div className="flex-1 overflow-hidden min-h-0">
          <ChatInterface
            mode="INTERVIEW"
            messages={messages}
            isStreaming={isAnswering}
            isLoadingHistory={historyLoading}
            onSendMessage={(msg) => submitAnswer(msg)}
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
                  <div>
                    <h4 className="font-semibold text-green-600 mb-1">Strengths</h4>
                    <ul className="list-disc pl-5 text-sm text-slate-700 dark:text-slate-300">
                      {assessment.strengths.map((s: string, i: number) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}

                {assessment.weaknesses && assessment.weaknesses.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-red-600 mb-1">Areas for Improvement</h4>
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
