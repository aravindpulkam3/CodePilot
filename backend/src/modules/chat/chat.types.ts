export type ChatSessionType = 'REPO_QA' | 'REVIEW_CHAT' | 'ISSUE_CHAT' | 'INTERVIEW' | 'QA' | 'REVIEW';

export interface ChatSessionRecord {
  id: string;
  user_id: string;
  type: ChatSessionType;
  repository_id?: string | null;
  review_id?: string | null;
  finding_id?: string | null;
  title?: string | null;
  status: string;
  state?: any;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRecord {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: any;
  created_at: string;
}

export interface ChatContextPayload {
  systemPrompt: string;
  sources?: any[];
  metadata?: Record<string, any>;
}

export interface ChatContextProvider {
  buildContext(
    session: ChatSessionRecord,
    userMessage: string,
    clerkUserId: string
  ): Promise<ChatContextPayload>;

  onAfterResponse?(
    session: ChatSessionRecord,
    fullAiResponse: string,
    clerkUserId: string
  ): Promise<void>;
}
