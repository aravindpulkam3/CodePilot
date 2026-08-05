import { useQuery } from "@tanstack/react-query";
import { getChatHistory, getChatSessions } from "@/services/api/repository";

export function useChatSessions(repositoryId: string) {
  return useQuery({
    queryKey: ["chatSessions", repositoryId],
    queryFn: () => getChatSessions(repositoryId),
    enabled: !!repositoryId,
  });
}

export function useChatHistory(sessionId: string | null) {
  return useQuery({
    queryKey: ["chatHistory", sessionId],
    queryFn: () => (sessionId ? getChatHistory(sessionId) : []),
    enabled: !!sessionId,
  });
}