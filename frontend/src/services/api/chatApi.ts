import { apiClient } from "./clientApi";
import { ChatMessage, ChatSession } from "@/types/chatTypes";

export interface UnifiedChatSession extends ChatSession {
  type: "REPO_QA" | "REVIEW_CHAT" | "ISSUE_CHAT" | "INTERVIEW" | "QA" | "REVIEW";
  review_id?: string | null;
  finding_id?: string | null;
  title?: string | null;
  status?: string;
  updated_at?: string;
}

export interface CreateSessionParams {
  type: "REPO_QA" | "REVIEW_CHAT" | "ISSUE_CHAT" | "INTERVIEW" | "QA" | "REVIEW";
  repositoryId?: string | null;
  reviewId?: string | null;
  findingId?: string | null;
  title?: string;
}

export const getOrCreateChatSession = async (
  params: CreateSessionParams
): Promise<UnifiedChatSession> => {
  const { data } = await apiClient.post<UnifiedChatSession>("/chat/sessions", params);
  return data;
};

export const listChatSessions = async (filters: {
  type?: string;
  repositoryId?: string;
  reviewId?: string;
  findingId?: string;
}): Promise<UnifiedChatSession[]> => {
  const params = new URLSearchParams();
  if (filters.type) params.append("type", filters.type);
  if (filters.repositoryId) params.append("repositoryId", filters.repositoryId);
  if (filters.reviewId) params.append("reviewId", filters.reviewId);
  if (filters.findingId) params.append("findingId", filters.findingId);

  const { data } = await apiClient.get<UnifiedChatSession[]>(
    `/chat/sessions?${params.toString()}`
  );
  return data;
};

export const getChatMessages = async (
  sessionId: string
): Promise<ChatMessage[]> => {
  const { data } = await apiClient.get<ChatMessage[]>(
    `/chat/sessions/${sessionId}/messages`
  );
  return data;
};

export const clearChatMessages = async (sessionId: string): Promise<void> => {
  await apiClient.delete(`/chat/sessions/${sessionId}/messages`);
};

export const deleteChatSession = async (sessionId: string): Promise<void> => {
  await apiClient.delete(`/chat/sessions/${sessionId}`);
};

export const streamChatMessage = async (
  sessionId: string | null,
  message: string,
  token: string,
  fallbackContext?: {
    type?: string;
    repositoryId?: string;
    reviewId?: string;
    findingId?: string;
  }
): Promise<Response> => {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000/api";
  const url = sessionId
    ? `${baseUrl}/chat/sessions/${sessionId}/stream`
    : `${baseUrl}/chat/stream`;

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message,
      sessionId,
      ...fallbackContext,
    }),
  });
};
