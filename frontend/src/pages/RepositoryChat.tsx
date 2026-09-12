import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useChatSessions, useChatHistory } from "@/hooks/useChat";
import { sendChatMessageStream } from "@/services/api/repositoryApi";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { readSseStream } from "@/utils/parseSseStream";
import type { SourceRef } from "@/types/sourceTypes";

/**
 * Codebase Q&A. The active conversation is a real URL param
 * (`/repositories/:id/chat/:sessionId`), not local state — refresh, deep
 * links, and browser back/forward all need to work for it.
 */
export default function RepositoryChat() {
  const { repositoryId, sessionId } = useParams<{ repositoryId: string; sessionId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [streamedSources, setStreamedSources] = useState<SourceRef[]>([]);

  const { data: chatSessions = [] } = useChatSessions(repositoryId!, "QA");
  const { data: history = [], isLoading: isHistoryLoading } = useChatHistory(sessionId ?? null);

  const handleSendMessage = async (msgToSend: string) => {
    if (!repositoryId || !msgToSend.trim() || isStreaming) return;
    setStreamedText("");
    setStreamedSources([]);
    setIsStreaming(true);

    const token = await getToken();
    if (!token) throw new Error("No token available");

    let resolvedSessionId = sessionId ?? null;

    try {
      const response = await sendChatMessageStream(repositoryId, msgToSend, resolvedSessionId, token);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Request failed (${response.status})`);
      }

      // Buffered across reads: the "sources" frame carries full excerpts and
      // routinely spans several network reads, which the old per-read split
      // silently dropped.
      let streamError: string | null = null;
      await readSseStream(response, (payload) => {
        // A server-side error mid-stream (e.g. still indexing) — surfaced to
        // the outer catch/toast below instead of being silently dropped.
        if (payload.type === "error") {
          streamError = payload.data || "Something went wrong.";
        } else if (payload.type === "sessionId") {
          resolvedSessionId = payload.data;
          // Same logical action as sending this message, not a
          // distinct navigation — replace, not push.
          navigate(`/repositories/${repositoryId}/chat/${payload.data}`, { replace: true });
        } else if (payload.type === "sources") {
          setStreamedSources(payload.data);
        } else if (payload.type === "text") {
          setStreamedText((prev) => prev + payload.data);
        }
      });
      if (streamError) throw new Error(streamError);

      await queryClient.invalidateQueries({ queryKey: ["chatHistory", resolvedSessionId] });
      await queryClient.invalidateQueries({ queryKey: ["chatSessions", repositoryId, "QA"] });
    } catch (error) {
      console.error("Chat error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setIsStreaming(false);
      setStreamedText("");
      setStreamedSources([]);
    }
  };

  return (
    <ChatInterface
      mode="QA"
      messages={history}
      isStreaming={isStreaming}
      streamedText={streamedText}
      streamedSources={streamedSources}
      onSendMessage={handleSendMessage}
      isLoadingHistory={isHistoryLoading}
      showSidebar={true}
      sessions={chatSessions}
      activeSessionId={sessionId ?? null}
      onSelectSession={(id) =>
        navigate(id ? `/repositories/${repositoryId}/chat/${id}` : `/repositories/${repositoryId}/chat`)
      }
      onNewSession={() => navigate(`/repositories/${repositoryId}/chat`)}
      emptyStateMessage="Ask a question about the codebase to get started."
      placeholder="Ask a question about the codebase..."
    />
  );
}
