import { ConversationTurn } from "../../shared/utils/conversationalQuery.js";
import type { PromptContextSnapshot } from "../../shared/prompts/sourceRefs.js";

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
  /**
   * Authoritative snapshot of the retrieved context actually rendered into
   * systemPrompt. Display sources are derived from it (toDisplaySources),
   * never from a second retrieval. Providers that do no retrieval omit it.
   */
  promptContext?: PromptContextSnapshot;
  metadata?: Record<string, any>;
}

export interface ConversationContext {
  // True when this is the first turn of a brand-new session — lets a
  // provider that calls retrieveQAContext use the cheap assertSearchable
  // readiness check on follow-up turns instead of the full sync-enqueue
  // ensureSearchable path on every message.
  isNewSession: boolean;
  // Oldest -> newest, may include the just-saved current user turn as the
  // last element. Used only to resolve dangling references ("that",
  // "where is this implemented") when constructing this turn's retrieval
  // query — never rendered into the prompt context itself.
  recentHistory: ConversationTurn[];
}

export interface ChatContextProvider {
  buildContext(
    session: ChatSessionRecord,
    userMessage: string,
    clerkUserId: string,
    // Providers that do no retrieval (Review, Issue) simply ignore this.
    conversation?: ConversationContext
  ): Promise<ChatContextPayload>;

  onAfterResponse?(
    session: ChatSessionRecord,
    fullAiResponse: string,
    clerkUserId: string
  ): Promise<void>;
}
