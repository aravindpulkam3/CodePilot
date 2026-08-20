import { useQuery } from "@tanstack/react-query";
import { getChatHistory, getChatSessions } from "@/services/api/repositoryApi";

export function useChatSessions(repositoryId: string, type: string = "QA") {
  return useQuery({
    queryKey: ["chatSessions", repositoryId, type],
    queryFn: () => getChatSessions(repositoryId, type),
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
