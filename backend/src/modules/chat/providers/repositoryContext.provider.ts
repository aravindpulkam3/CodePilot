import { ChatContextProvider, ChatContextPayload, ChatSessionRecord } from "../chat.types.js";
import { retrievalService } from "../../../services/retreival.service.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { docRetrievalLog } from "../../../utils/readmeDebugLog.js";

export class RepositoryContextProvider implements ChatContextProvider {
  async buildContext(
    session: ChatSessionRecord,
    userMessage: string,
    clerkUserId: string
  ): Promise<ChatContextPayload> {
    if (!session.repository_id) {
      throw new Error("Repository ID is required for REPO_QA chat sessions.");
    }

    // Retrieve semantically relevant codebase chunks via AST / vector search,
    // plus any README sections that independently matched the question.
    const retrieved = await retrievalService.retrieveQAContext(
      clerkUserId,
      session.repository_id,
      userMessage
    );

    const codeChunks = retrieved.codeChunks || [];
    const docChunks = retrieved.docChunks || [];

    // Documentation and code are numbered in SEPARATE citation namespaces
    // ([Doc N] vs [Source N]). That distinction is what carries source
    // authority through to the answer — the model can tell the user which of
    // its claims came from the maintainer's prose and which from the code.
    const docContext = docChunks
      .map((d, i) => `[Doc ${i + 1}]: ${d.filePath} § ${d.sectionPath}\n${d.content}`)
      .join("\n\n");

    const codeContext = codeChunks
      .map(
        (s, i) =>
          `[Source ${i + 1}]: ${s.filePath} (Lines ${s.lineStart}-${s.lineEnd})\n\`\`\`\n${s.content}\n\`\`\``
      )
      .join("\n\n");

    // The repository-level summary was previously retrieved and thrown away.
    // It is the cheapest possible answer to "what does this project do".
    const repo = retrieved.repository as any;
    const overview = repo
      ? [
          repo.purpose ? `Purpose: ${repo.purpose}` : null,
          repo.summary ? `Summary: ${repo.summary}` : null,
          repo.techStack?.length ? `Tech stack: ${repo.techStack.join(", ")}` : null,
          repo.features?.length ? `Features: ${repo.features.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    const hasAnyContext = Boolean(overview || docContext || codeContext);

    const sections: string[] = [
      `You are a Senior Software Engineer helping explain a codebase.`,
      ``,
      `Source authority:`,
      `- Documentation ([Doc N]) states the maintainer's documented intent, setup steps, and project description. Treat it as authoritative for WHAT THE PROJECT IS FOR and HOW TO RUN IT.`,
      `- Code ([Source N]) is authoritative for WHAT THE SYSTEM ACTUALLY DOES TODAY.`,
      `- If documentation and code disagree about current behaviour, trust the code, and say plainly that the documentation appears out of date.`,
      ``,
      `Cite sources as [Doc N] or [Source N] when referring to specific files or logic.`,
      `Give a clean, structured response without unnecessary symbols.`,
    ];

    if (!hasAnyContext) {
      // Previously this still instructed the model to cite [Source X] over
      // the string "No specific code chunks retrieved." — which is what
      // produced confident-sounding "I have no access to your files"
      // answers that read like a broken integration rather than an empty
      // search result.
      sections.push(
        ``,
        `No indexed content matched this question. Tell the user that directly:`,
        `nothing in the indexed repository matched, they could try rephrasing,`,
        `and the repository may still be finishing indexing. Do not speculate`,
        `about the codebase and do not cite any sources.`,
      );
    } else {
      if (overview) sections.push(``, `## Repository Overview`, overview);
      if (docContext) sections.push(``, `## Documentation`, docContext);
      if (codeContext) sections.push(``, `## Code`, codeContext);
    }

    const systemPrompt = sections.join("\n");

    // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
    // This is the last hop before the LLM: it proves documentation actually
    // reached the prompt, rather than merely being retrieved upstream.
    docRetrievalLog(
      `Q&A prompt assembled: ${docChunks.length} [Doc] block(s), ${codeChunks.length} [Source] block(s), ` +
        `overview=${overview ? "yes" : "no"}, docContext=${docContext.length} chars, ` +
        `codeContext=${codeContext.length} chars, systemPrompt=${systemPrompt.length} chars total.` +
        (hasAnyContext ? "" : " NO CONTEXT — model instructed to say nothing matched."),
    );

    // Both kinds go to the client as sources, tagged so the UI can render a
    // README section differently from a code span.
    const sources = [
      ...docChunks.map((d) => ({ ...d, sourceKind: "documentation" as const })),
      ...codeChunks.map((c) => ({ ...c, sourceKind: "code" as const })),
    ];

    return {
      systemPrompt,
      sources,
      metadata: {
        repositoryId: session.repository_id,
        sourcesCount: sources.length,
        codeSourcesCount: codeChunks.length,
        docSourcesCount: docChunks.length,
        noContextFound: !hasAnyContext,
      },
    };
  }
}
