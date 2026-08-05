import {
  LocalRepository,
  PullRequestDetail,
  PullRequestItem,
} from "@/types/repository";
import { apiClient } from "./client";
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

export const getChatSessions = async (repositoryId: string): Promise<ChatSession[]> => {
  const { data } = await apiClient.get<ChatSession[]>(`/repositories/${repositoryId}/sessions?type=QA`);
  return data;
};

export const getChatHistory = async (sessionId: string): Promise<ChatMessage[]> => {
  const { data } = await apiClient.get<ChatMessage[]>(`/sessions/${sessionId}/messages`);
  return data;
};

export const sendChatMessageStream = async (
  repositoryId: string,
  message: string,
  sessionId: string | null,
  token: string
): Promise<Response> => {
  // We return the raw fetch Response so the frontend component can attach a reader to the stream.
  const baseUrl = import.meta.env.VITE_API_BASE_URL || "";
  return fetch(`${baseUrl}/repositories/${repositoryId}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}` // <--- 2. MANUALLY ATTACH IT HERE
    },
    body: JSON.stringify({ message, sessionId, type: "QA" }),
  });
};