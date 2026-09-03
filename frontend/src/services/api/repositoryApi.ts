import {
  LocalRepository,
  PullRequestDetail,
  PullRequestItem,
} from "@/types/repositoryTypes";
import { apiClient } from "./clientApi";
import { ChatMessage, ChatSession } from "@/types/chatTypes";

export const getRepoDetails = async (
  repositoryId: string,
): Promise<LocalRepository> => {
  const { data } = await apiClient.get<LocalRepository>(
    `/repositories/${repositoryId}`,
  );
  return data;
};

export const getRepoPullRequests = async (
  repositoryId: string,
): Promise<PullRequestItem[]> => {
  const { data } = await apiClient.get<PullRequestItem[]>(
    `/repositories/${repositoryId}/pulls`,
  );
  return data;
};

export const getPullRequestDetails = async (
  repositoryId: string,
  pullNumber: string,
): Promise<PullRequestDetail> => {
  const { data } = await apiClient.get<PullRequestDetail>(
    `/repositories/${repositoryId}/pulls/${pullNumber}`,
  );
  return data;
};

export const getChatSessions = async (
  repositoryId: string,
  type: string = "QA",
): Promise<ChatSession[]> => {
  const { data } = await apiClient.get<ChatSession[]>(
    `/chat/sessions?repositoryId=${repositoryId}&type=${type}`,
  );
  return data;
};

export const getChatHistory = async (
  sessionId: string,
): Promise<ChatMessage[]> => {
  const { data } = await apiClient.get<ChatMessage[]>(
    `/chat/sessions/${sessionId}/messages`,
  );
  return data;
};

export const sendChatMessageStream = async (
  repositoryId: string,
  message: string,
  sessionId: string | null,
  token: string,
  type: string = "QA",
): Promise<Response> => {
  // We return the raw fetch Response so the frontend component can attach a reader to the stream.
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  if (!baseUrl) throw new Error("VITE_API_BASE_URL is not configured.");
  const url = sessionId
    ? `${baseUrl}/chat/sessions/${sessionId}/stream`
    : `${baseUrl}/chat/stream`;

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`, // <--- 2. MANUALLY ATTACH IT HERE
    },
    body: JSON.stringify({ message, sessionId, type, repositoryId }),
  });
};
