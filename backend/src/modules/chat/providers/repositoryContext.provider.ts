import { ChatContextProvider, ChatContextPayload, ChatSessionRecord } from "../chat.types.js";
import { retrievalService } from "../../../services/retreival.service.js";

export class RepositoryContextProvider implements ChatContextProvider {
  async buildContext(
    session: ChatSessionRecord,
    userMessage: string,
    clerkUserId: string
  ): Promise<ChatContextPayload> {
    if (!session.repository_id) {
      throw new Error("Repository ID is required for REPO_QA chat sessions.");
    }

    // Retrieve semantically relevant codebase chunks via AST / vector search
    const retrieved = await retrievalService.retrieveQAContext(
      clerkUserId,
      session.repository_id,
      userMessage
    );

    const sources = retrieved.codeChunks || [];
    const contextString = sources
      .map(
        (s, i) =>
          `[Source ${i + 1}]: ${s.filePath} (Lines ${s.lineStart}-${s.lineEnd})\n\`\`\`\n${s.content}\n\`\`\``
      )
      .join("\n\n");

    const systemPrompt = `You are a Senior Software Engineer helping explain a codebase.
Use the provided code context to answer the user's question clearly and accurately.
Always cite your sources using the [Source X] format when referring to specific files or logic.
Give a clean, structured response without unnecessary symbols.

Code Context:
${contextString || "No specific code chunks retrieved."}`;

    return {
      systemPrompt,
      sources,
      metadata: { repositoryId: session.repository_id, sourcesCount: sources.length },
    };
  }
}
