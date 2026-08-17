// pages/InterviewPage.tsx
import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardBody } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { useRepositoryDetails } from '@/hooks/useRepository';
import { apiClient } from '@/services/api/clientApi';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface InterviewConfig {
  difficulty: 'easy' | 'medium' | 'hard' | 'adaptive';
  domain: string;
  mode: 'repository' | 'general';
}

export function InterviewPage() {
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const navigate = useNavigate();

  const { data: repo, isLoading: repoLoading } = useRepositoryDetails(repositoryId!);

  const [session, setSession] = useState<{ sessionId: string } | null>(null);
  const [config, setConfig] = useState<InterviewConfig>({
    difficulty: 'medium',
    domain: 'development',
    mode: 'repository',
  });
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isAnswering, setIsAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isAnswering]);

  const startInterview = async () => {
    if (!repositoryId) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const res = await apiClient.post('/interview/start', {
        config: {
          ...config,
          repositoryId,
          followUpsEnabled: true,
        },
      });
      const data = res.data;
      setSession({ sessionId: data.sessionId });
      setMessages([{ role: 'assistant', content: data.firstQuestion }]);
    } catch (e) {
      console.error(e);
      setStartError('Could not start the interview. Please try again.');
    } finally {
      setIsStarting(false);
    }
  };

  const submitAnswer = async () => {
    if (!input.trim() || !session || isAnswering || isComplete) return;

    const userMsg = input.trim();
    setInput('');
    setAnswerError(null);
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);

    setIsAnswering(true);
    try {
      const res = await apiClient.post(`/interview/${session.sessionId}/answer`, { answer: userMsg });
      const data = res.data;

      if (data.nextQuestion) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.nextQuestion }]);
      } else if (data.assessment) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Interview complete. ${data.assessment.overallAssessment}`,
        }]);
        setIsComplete(true);
      }
    } catch (e) {
      console.error(e);
      setAnswerError('Something went wrong sending your answer. Please try again.');
      setInput(userMsg);
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsAnswering(false);
    }
  };

  const header = (
    <div className="mb-6">
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
          description={repo.description || "Interactive technical interview based on repository context"}
        />
      ) : null}
    </div>
  );

  if (!session) {
    return (
      <div className="max-w-2xl mx-auto py-10 px-4">
        {header}
        <Card>
          <CardBody className="p-6">
            <h2 className="text-lg font-semibold mb-1">Start Technical Interview</h2>
            <p className="text-sm text-muted-light mb-6">
              We'll ask questions grounded in this repository's architecture and code.
            </p>
            <div className="space-y-4 max-w-md">
              <div>
                <label className="block text-sm mb-1">Difficulty</label>
                <select
                  className="w-full rounded-md border border-border-light bg-surface-light px-3 py-2 text-sm text-ink-light"
                  value={config.difficulty}
                  onChange={e => setConfig({ ...config, difficulty: e.target.value as InterviewConfig['difficulty'] })}
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
                  onChange={e => setConfig({ ...config, domain: e.target.value })}
                >
                  <option value="development">Development</option>
                  <option value="system-design">System Design</option>
                  <option value="debugging">Debugging</option>
                </select>
              </div>
              {startError && <p className="text-sm text-red-500">{startError}</p>}
              <Button onClick={startInterview} disabled={isStarting || repoLoading}>
                {isStarting ? 'Starting...' : 'Start Interview'}
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      {header}
      <div className="flex flex-col h-[600px] border border-border-light dark:border-border-dark rounded-xl overflow-hidden bg-surface-light dark:bg-surface-dark">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((m, idx) => (
            <div key={idx} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-[80%] rounded-2xl px-4 py-3 whitespace-pre-wrap',
                m.role === 'user'
                  ? 'bg-signal-500 text-white'
                  : 'bg-surface-light dark:bg-surface-dark text-ink-light dark:text-ink-dark border border-border-light dark:border-border-dark'
              )}>
                {m.content}
              </div>
            </div>
          ))}
          {isAnswering && (
            <div className="flex justify-start">
              <div className="bg-surface-light dark:bg-surface-dark text-ink-light dark:text-ink-dark border border-border-light dark:border-border-dark rounded-2xl px-4 py-3 animate-pulse">
                Interviewer is typing...
              </div>
            </div>
          )}
        </div>
        <div className="p-4 border-t border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark">
          {answerError && <p className="text-sm text-red-500 mb-2">{answerError}</p>}
          {isComplete ? (
            <div className="flex justify-between items-center">
              <p className="text-sm text-muted-light">This interview has ended.</p>
              <Button onClick={() => navigate(-1)}>Back to repository</Button>
            </div>
          ) : (
            <>
              <textarea
                className="w-full p-3 rounded-lg border border-border-light dark:border-border-dark bg-transparent text-ink-light dark:text-ink-dark placeholder:text-muted-light focus:outline-none focus:ring-2 focus:ring-signal-500 min-h-[100px]"
                placeholder="Type your answer..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitAnswer();
                  }
                }}
              />
              <div className="flex justify-end mt-2">
                <Button onClick={submitAnswer} disabled={!input.trim() || isAnswering}>
                  Submit Answer
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}