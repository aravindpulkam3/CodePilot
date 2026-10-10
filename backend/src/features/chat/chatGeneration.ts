import type { ChatContextProvider, ChatSessionRecord, ConversationContext } from "./chat.types.js";
import type { StreamChunk } from "./chat.service.js";
import type { LLMService, LLMMessage } from "../../infrastructure/llm/llm.service.js";
import { toDisplaySources } from "../../shared/prompts/sourceRefs.js";
import { observe } from "../../shared/utils/diagnostics.js";

/** Shared generation only. The production caller retains all message/session writes. */
export async function generateChatResponse(
  provider: ChatContextProvider,
  llm: Pick<LLMService, "stream" | "modelName">,
  session: ChatSessionRecord,
  userMessage: string,
  clerkUserId: string,
  orderedHistory: { role: string; content: string }[],
  onChunk: (chunk: StreamChunk) => void,
  options: Omit<ConversationContext, "recentHistory">,
) {
  // Keep prompt history independent of the array supplied to context providers,
  // as it was before extraction.
  const conversationHistory: LLMMessage[] = orderedHistory.map(row => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
  }));
  const recentHistory = orderedHistory.map(row => ({
    role: row.role === "assistant" ? "assistant" as const : "user" as const,
    content: row.content,
  }));
  const started = performance.now();
  const context = await provider.buildContext(session, userMessage, clerkUserId, {
    ...options, recentHistory,
  });
  const contextMs = performance.now() - started;
  const displaySources = toDisplaySources(context.promptContext);
  if (displaySources.length > 0) onChunk({ type: "sources", data: displaySources });
  if (context.metadata) onChunk({ type: "metadata", data: context.metadata });
  const messages: LLMMessage[] = [{ role: "system", content: context.systemPrompt }, ...conversationHistory];
  observe(options.onDiagnostic, "qa.request", { messages, context, model: llm.modelName, contextMs });
  let fullAiResponse = "";
  const generationStarted = performance.now();
  let firstTextMs: number | null = null;
  for await (const chunk of llm.stream(messages, options.onDiagnostic)) {
    if (chunk.text) {
      firstTextMs ??= performance.now() - generationStarted;
      fullAiResponse += chunk.text;
      onChunk({ type: "text", data: chunk.text });
    }
  }
  observe(options.onDiagnostic, "qa.response", {
    fullAiResponse, generationMs: performance.now() - generationStarted, firstTextMs,
  });
  return { context, fullAiResponse };
}
