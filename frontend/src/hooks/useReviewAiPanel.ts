import { useCallback, useState } from "react";
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
import { readSseStream } from "@/utils/parseSseStream";
import { toast } from "sonner";

export type ReviewAiScope = "review" | "finding";

/**
 * Drives the PR Review AI panel's two scopes on one shared hook shape:
 * "review" (whole-PR Q&A, type REVIEW_CHAT + reviewId) and "finding"
 * (scoped discussion, type ISSUE_CHAT + findingId). This is a new,
 * independent hook (not a change to useUnifiedChat.ts's
 * useFindingDiscussion, which Q&A/Interview-adjacent code still uses)
 * so the review panel's needs (scope switching) don't leak into it.
 */
export function useReviewAiPanel(
  scope: ReviewAiScope,
  id: string | null,
  repositoryId?: string
) {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState("");

  const sessionParams =
    scope === "review"
      ? { type: "REVIEW_CHAT" as const, reviewId: id, repositoryId }
      : { type: "ISSUE_CHAT" as const, findingId: id, repositoryId };

  const {
    data: session,
    isLoading: isSessionLoading,
    error: sessionError,
  } = useQuery<UnifiedChatSession>({
    queryKey: ["reviewAiSession", scope, id],
    queryFn: () => getOrCreateChatSession(sessionParams),
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  });

  const {
    data: messages = [],
    isLoading: isMessagesLoading,
    refetch: refetchMessages,
  } = useQuery<ChatMessage[]>({
    queryKey: ["reviewAiMessages", session?.id],
    queryFn: () => getChatMessages(session!.id),
    enabled: !!session?.id,
  });

  const sendMessage = useCallback(
    async (userMessage: string) => {
      if (!id || !userMessage.trim() || isStreaming) return;

      const token = await getToken();
      if (!token) throw new Error("Authentication token required.");

      setIsStreaming(true);
      setStreamedText("");

      try {
        let activeSessionId = session?.id;
        if (!activeSessionId) {
          const newSession = await getOrCreateChatSession(sessionParams);
          activeSessionId = newSession.id;
          queryClient.setQueryData(["reviewAiSession", scope, id], newSession);
        }

        const response = await streamChatMessage(activeSessionId, userMessage, token, {
          type: sessionParams.type,
          repositoryId,
          reviewId: scope === "review" ? id ?? undefined : undefined,
          findingId: scope === "finding" ? id ?? undefined : undefined,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || `Request failed (${response.status})`);
        }

        let streamError: string | null = null;
        await readSseStream(response, (payload) => {
          if (payload.type === "error") {
            streamError = payload.data || "Something went wrong.";
          } else if (payload.type === "text") {
            setStreamedText((prev) => prev + payload.data);
          }
        });
        if (streamError) throw new Error(streamError);

        await queryClient.invalidateQueries({ queryKey: ["reviewAiMessages", activeSessionId] });
      } catch (err) {
        console.error("Review AI panel stream error:", err);
        toast.error(err instanceof Error ? err.message : "Failed to send message.");
      } finally {
        setIsStreaming(false);
        setStreamedText("");
      }
    },
    [id, session?.id, repositoryId, isStreaming, getToken, queryClient, scope]
  );

  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!session?.id) return;
      await clearChatMessages(session.id);
    },
    onSuccess: () => {
      if (session?.id) {
        queryClient.setQueryData(["reviewAiMessages", session.id], []);
      }
    },
  });

  return {
    session,
    messages,
    isLoading: isSessionLoading || isMessagesLoading,
    isStreaming,
    streamedText,
    sendMessage,
    clearHistory: clearMutation.mutate,
    isClearing: clearMutation.isPending,
    refetchMessages,
    error: sessionError,
  };
}
