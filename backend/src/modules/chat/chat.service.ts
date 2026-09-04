import { pool } from "../../config/db.js";
import { llmService, LLMMessage, ollamaService } from "../../services/llm.service.js";
import {
  ChatSessionRecord,
  ChatSessionType,
  ChatContextProvider,
} from "./chat.types.js";
import { RepositoryContextProvider } from "./providers/repositoryContext.provider.js";
import { ReviewContextProvider } from "./providers/reviewContext.provider.js";
import { IssueContextProvider } from "./providers/issueContext.provider.js";
import { InterviewContextProvider } from "./providers/interviewContext.provider.js";
import { activityLogService } from "../../services/activityLog.service.js";

export type StreamChunk =
  | { type: "sources"; data: any[] }
  | { type: "text"; data: string }
  | { type: "metadata"; data: any }
  | { type: "sessionId"; data: string };

export class ChatService {
  private providers: Record<string, ChatContextProvider> = {
    REPO_QA: new RepositoryContextProvider(),
    QA: new RepositoryContextProvider(), // alias
    REVIEW_CHAT: new ReviewContextProvider(),
    REVIEW: new ReviewContextProvider(), // alias
    ISSUE_CHAT: new IssueContextProvider(),
    INTERVIEW: new InterviewContextProvider(),
  };

  /**
   * Normalizes session type aliases
   */
  private normalizeType(type: string): ChatSessionType {
    if (type === "QA") return "REPO_QA";
    if (type === "REVIEW") return "REVIEW_CHAT";
    return type as ChatSessionType;
  }

  /**
   * Finds or creates a chat session.
   * For ISSUE_CHAT, strictly enforces 1 session per finding per user.
   */
  async getOrCreateSession(params: {
    userId: string;
    type: string;
    repositoryId?: string | null;
    reviewId?: string | null;
    findingId?: string | null;
    title?: string | null;
  }): Promise<ChatSessionRecord> {
    const { userId, repositoryId, reviewId, findingId, title } = params;
    const normalizedType = this.normalizeType(params.type);

    // 1. For ISSUE_CHAT, check if a session already exists for this finding & user
    if (normalizedType === "ISSUE_CHAT" && findingId) {
      const { rows: existing } = await pool.query(
        `SELECT * FROM chat_sessions 
         WHERE finding_id = $1 AND user_id = $2 AND type = 'ISSUE_CHAT'`,
        [findingId, userId]
      );
      if (existing.length > 0) {
        return existing[0];
      }
    }

    // 2. Insert new session
    const defaultTitle =
      title ||
      (normalizedType === "ISSUE_CHAT"
        ? "Finding Discussion"
        : normalizedType === "REVIEW_CHAT"
          ? "PR Review Chat"
          : normalizedType === "INTERVIEW"
            ? "Interview Session"
            : "Repository Q&A");

    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (user_id, type, repository_id, review_id, finding_id, title)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        userId,
        normalizedType,
        repositoryId || null,
        reviewId || null,
        findingId || null,
        defaultTitle,
      ]
    );

    const session: ChatSessionRecord = rows[0];

    // 3. If INTERVIEW mode, initialize companion state record in interview_sessions
    if (normalizedType === "INTERVIEW" && repositoryId) {
      await pool.query(
        `INSERT INTO interview_sessions (session_id, user_id, repository_id, current_topic)
         VALUES ($1, $2, $3, 'System Architecture & Engineering')
         ON CONFLICT (session_id) DO NOTHING`,
        [session.id, userId, repositoryId]
      );
    }

    // 4. Log the creation activity
    await activityLogService.logEvent({
      userId,
      repositoryId: repositoryId || null,
      activityType: `${normalizedType}_STARTED`,
      metadata: {
        title: defaultTitle,
        sessionId: session.id,
      },
    });

    return session;
  }

  async getSession(
    sessionId: string,
    userId: string
  ): Promise<ChatSessionRecord> {
    const { rows } = await pool.query(
      `UPDATE chat_sessions SET last_accessed_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [sessionId, userId]
    );
    if (rows.length === 0) {
      throw new Error(`Chat session not found: ${sessionId}`);
    }
    return rows[0];
  }

  async listSessions(
    userId: string,
    filters: {
      type?: string;
      repositoryId?: string;
      reviewId?: string;
      findingId?: string;
    }
  ): Promise<ChatSessionRecord[]> {
    let query = `SELECT * FROM chat_sessions WHERE user_id = $1`;
    const values: any[] = [userId];

    if (filters.type) {
      const normType = this.normalizeType(filters.type);
      values.push(normType);
      query += ` AND type = $${values.length}`;
    }
    if (filters.repositoryId) {
      values.push(filters.repositoryId);
      query += ` AND repository_id = $${values.length}`;
    }
    if (filters.reviewId) {
      values.push(filters.reviewId);
      query += ` AND review_id = $${values.length}`;
    }
    if (filters.findingId) {
      values.push(filters.findingId);
      query += ` AND finding_id = $${values.length}`;
    }

    query += ` ORDER BY updated_at DESC`;
    const { rows } = await pool.query(query, values);
    return rows;
  }

  async getMessages(sessionId: string) {
    const { rows } = await pool.query(
      `SELECT id, role, content, metadata, created_at 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at ASC`,
      [sessionId]
    );
    return rows;
  }

  async saveMessage(
    sessionId: string,
    role: "user" | "assistant" | "system",
    content: string,
    metadata: any = {}
  ): Promise<void> {
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, metadata)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, role, content, JSON.stringify(metadata)]
    );
  }

  async deleteSession(sessionId: string, userId: string): Promise<void> {
    await pool.query(
      `DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
  }

  async clearMessages(sessionId: string, userId: string): Promise<void> {
    // Validate ownership
    await this.getSession(sessionId, userId);
    await pool.query(`DELETE FROM chat_messages WHERE session_id = $1`, [
      sessionId,
    ]);
  }

  /**
   * Universal streaming orchestrator:
   * 1. Saves user message
   * 2. Resolves context from the appropriate provider
   * 3. Fetches conversation history
   * 4. Streams response via LLM service
   * 5. Saves assistant message & executes after-hooks
   */
  async streamMessage(
    session: ChatSessionRecord,
    userMessage: string,
    clerkUserId: string,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void> {
    // 1. Save user turn
    await this.saveMessage(session.id, "user", userMessage);

    // 2. Fetch context from the registered provider
    const normType = this.normalizeType(session.type);
    const provider = this.providers[normType] || this.providers["REPO_QA"];

    const context = await provider.buildContext(session, userMessage, clerkUserId);

    if (context.sources && context.sources.length > 0) {
      onChunk({ type: "sources", data: context.sources });
    }
    if (context.metadata) {
      onChunk({ type: "metadata", data: context.metadata });
    }

    // 3. Fetch recent conversation history
    const { rows: historyRows } = await pool.query(
      `SELECT role, content 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [session.id]
    );

    const conversationHistory: LLMMessage[] = historyRows
      .reverse()
      .map((row) => ({
        role: row.role === "assistant" ? "assistant" : "user",
        content: row.content,
      }));

    // 4. Build prompt
    const messages: LLMMessage[] = [
      { role: "system", content: context.systemPrompt },
      ...conversationHistory,
    ];

    // 5. Stream LLM tokens
    let fullAiResponse = "";
    const stream = llmService.stream(messages);

    for await (const chunk of stream) {
      if (chunk.text) {
        fullAiResponse += chunk.text;
        onChunk({ type: "text", data: chunk.text });
      }
    }

    // 6. Save assistant turn to database
    await this.saveMessage(
      session.id,
      "assistant",
      fullAiResponse,
      context.metadata || {}
    );

    // 7. Update session timestamp
    await pool.query(
      `UPDATE chat_sessions SET updated_at = NOW(), last_accessed_at = NOW() WHERE id = $1`,
      [session.id]
    );

    // 8. Optional provider post-response hook
    if (provider.onAfterResponse) {
      await provider.onAfterResponse(session, fullAiResponse, clerkUserId);
    }
  }
}

export const chatService = new ChatService();
