import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/clerk-react";
import {
  getOrCreateChatSession,
  getChatMessages,
  clearChatMessages,
  streamChatMessage,
  UnifiedChatSession,
} from "@/services/api/chatApi";
import { ChatMessage } from "@/types/chatTypes";

export function useFindingDiscussion(findingId: string | null, repositoryId?: string) {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [streamedSources, setStreamedSources] = useState<any[]>([]);

  // 1. Fetch or initialize the single finding session
  const {
    data: session,
    isLoading: isSessionLoading,
    error: sessionError,
  } = useQuery<UnifiedChatSession>({
    queryKey: ["findingSession", findingId],
    queryFn: () =>
      getOrCreateChatSession({
        type: "ISSUE_CHAT",
        findingId: findingId!,
        repositoryId,
        title: `Discussion for Finding #${findingId?.slice(0, 8)}`,
      }),
    enabled: !!findingId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // 2. Fetch persistent message history for this finding
  const {
    data: messages = [],
    isLoading: isMessagesLoading,
    refetch: refetchMessages,
  } = useQuery<ChatMessage[]>({
    queryKey: ["chatMessages", session?.id],
    queryFn: () => getChatMessages(session!.id),
    enabled: !!session?.id,
  });

  // 3. Send streaming message
  const sendMessage = useCallback(
    async (userMessage: string) => {
      if (!findingId || !userMessage.trim() || isStreaming) return;

      const token = await getToken();
      if (!token) throw new Error("Authentication token required.");

      setIsStreaming(true);
      setStreamedText("");
      setStreamedSources([]);

      try {
        let activeSessionId = session?.id;

        // Ensure session exists
        if (!activeSessionId) {
          const newSession = await getOrCreateChatSession({
            type: "ISSUE_CHAT",
            findingId,
            repositoryId,
          });
          activeSessionId = newSession.id;
          queryClient.setQueryData(["findingSession", findingId], newSession);
        }

        const response = await streamChatMessage(activeSessionId, userMessage, token, {
          type: "ISSUE_CHAT",
          findingId,
          repositoryId,
        });

        if (!response.body) throw new Error("No response stream body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const jsonStr = line.replace("data: ", "");
              try {
                const payload = JSON.parse(jsonStr);
                if (payload.type === "text") {
                  setStreamedText((prev) => prev + payload.data);
                } else if (payload.type === "sources") {
                  setStreamedSources(payload.data);
                }
              } catch (e) {
                // Ignore parse errors on partial chunks
              }
            }
          }
        }

        // Invalidate message history cache to sync DB state
        await queryClient.invalidateQueries({
          queryKey: ["chatMessages", activeSessionId],
        });
      } catch (err) {
        console.error("Finding discussion stream error:", err);
      } finally {
        setIsStreaming(false);
        setStreamedText("");
        setStreamedSources([]);
      }
    },
    [findingId, session?.id, repositoryId, isStreaming, getToken, queryClient]
  );

  // 4. Clear chat history mutation
  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!session?.id) return;
      await clearChatMessages(session.id);
    },
    onSuccess: () => {
      if (session?.id) {
        queryClient.setQueryData(["chatMessages", session.id], []);
      }
    },
  });

  return {
    session,
    messages,
    isLoading: isSessionLoading || isMessagesLoading,
    isStreaming,
    streamedText,
    streamedSources,
    sendMessage,
    clearHistory: clearMutation.mutate,
    isClearing: clearMutation.isPending,
    refetchMessages,
    error: sessionError,
  };
}
