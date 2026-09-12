import { ChatContextProvider, ChatContextPayload, ChatSessionRecord, ConversationContext } from "../chat.types.js";
import { retrievalService } from "../../../infrastructure/retrieval/retreival.service.js";
import { findRepositoryById } from "../../repository/repository.service.js";
import { BASE_SOURCE_AUTHORITY, NUMBERED_CITATION_RULE } from "../../../shared/prompts/sharedCitations.js";
import { buildQAPromptContext, BudgetTier } from "./qaPromptContext.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { docRetrievalLog } from "../../../shared/utils/readmeDebugLog.js";

/**
 * Matches DEFAULT_OPTIONS.similarityThreshold / docSimilarityThreshold in
 * retreival.service.ts. This provider never overrides those (always calls
 * retrieveQAContext with opts=undefined), so hardcoding the same default
 * here — rather than threading the actual options object across the
 * service boundary just for this — is a deliberate, low-risk shortcut.
 */
const BASE_THRESHOLD = 0.6;
/** "Not merely threshold-scraping" — code's own bar for getting full budget regardless of other types. */
const SOLID_MARGIN = 0.05;
/** "Unambiguously strong in its own right" — lets a doc/summary section win full budget even alongside solid code. */
const STRONG_MARGIN = 0.15;

/**
 * Decides how much prompt budget a repository/architecture/component/doc
 * section earns THIS turn — not "non-empty," a relative judgment against
 * how solid code's own match is. Code is never compared against these
 * types by raw similarity (see the module-level comment above); its own
 * tier is decided separately, self-referentially, in buildContext below.
 *
 * - No match at all -> omit.
 * - Code isn't a solid match this turn (weak or absent) -> full. This is
 *   the broad-question case: nothing here is competing with a confident
 *   code answer, so show the intent/design evidence at full strength.
 * - Code IS solid, but this section's own match is unambiguously strong on
 *   its own terms -> full anyway. Some questions are genuinely hybrid.
 * - Code is solid and this section is merely present, not standout -> reduced.
 */
function summaryTierGivenCode(ownSimilarity: number | null, codeMargin: number): BudgetTier {
  if (ownSimilarity === null) return "omit";
  const ownMargin = ownSimilarity - BASE_THRESHOLD;
  const codeIsSolid = codeMargin >= SOLID_MARGIN;
  if (!codeIsSolid) return "full";
  if (ownMargin >= STRONG_MARGIN) return "full";
  return "reduced";
}

/**
 * Code's own tier never depends on comparing its raw score against docs or
 * summaries — its role (authoritative for current behaviour) means it gets
 * full budget whenever ITS OWN match is solid, independent of what else
 * matched. Only drops to reduced/omit when code itself is weak or absent.
 */
function codeTier(codeSimilarity: number | null): BudgetTier {
  if (codeSimilarity === null) return "omit";
  const margin = codeSimilarity - BASE_THRESHOLD;
  return margin >= SOLID_MARGIN ? "full" : "reduced";
}

export class RepositoryContextProvider implements ChatContextProvider {
  async buildContext(
    session: ChatSessionRecord,
    userMessage: string,
    clerkUserId: string,
    conversation?: ConversationContext
  ): Promise<ChatContextPayload> {
    if (!session.repository_id) {
      throw new Error("Repository ID is required for REPO_QA chat sessions.");
    }

    // Retrieve semantically relevant codebase chunks via AST / vector search,
    // plus any README sections that independently matched the question.
    // conversation.recentHistory helps retrieval resolve dangling references
    // ("that", "where is this implemented") — it is never itself rendered
    // into the returned context below. The repository row is only needed for
    // html_url (pinned source links), so a failed lookup never fails the turn.
    const [retrieved, repo] = await Promise.all([
      retrievalService.retrieveQAContext(
        clerkUserId,
        session.repository_id,
        userMessage,
        undefined,
        conversation
          ? { isNewSession: conversation.isNewSession, recentHistory: conversation.recentHistory }
          : undefined
      ),
      findRepositoryById(session.repository_id).catch(() => null),
    ]);

    const sim = retrieved.metadata.evidenceSimilarities ?? {
      repository: null,
      architecture: null,
      component: null,
      doc: null,
      code: null,
    };

    // Relevance-and-role weighting: which sections get full budget, reduced
    // budget, or are omitted this turn. codeMargin drives every other
    // type's tier (asymmetric — code's role as "authoritative for current
    // behaviour" means it isn't crowded out by a docs/summary section that
    // merely scored a marginally higher raw number); code's own tier never
    // looks at the others. See the module-level comments on
    // summaryTierGivenCode/codeTier for the exact rule.
    const codeMargin = (sim.code ?? -Infinity) - BASE_THRESHOLD;
    const repositoryTier = summaryTierGivenCode(sim.repository, codeMargin);
    const architectureTier = summaryTierGivenCode(sim.architecture, codeMargin);
    const componentTier = summaryTierGivenCode(sim.component, codeMargin);
    const docTier = summaryTierGivenCode(sim.doc, codeMargin);
    const codeSectionTier = codeTier(sim.code);

    // One numbered [n] list across every evidence type, rendered and
    // recorded in the same pass — the snapshot below is exactly what the
    // prompt contains, including which entries the budgets skipped (absent)
    // and which were truncated. Docs and code keep distinct kind labels,
    // which is what carries source authority now that they share numbering.
    const { promptText, items } = buildQAPromptContext({
      repository: retrieved.repository,
      repositoryTier,
      architecture: retrieved.architecture,
      architectureTier,
      components: retrieved.components,
      componentTier,
      docChunks: retrieved.docChunks || [],
      docTier,
      codeChunks: retrieved.codeChunks || [],
      codeTier: codeSectionTier,
      graphNeighbors: retrieved.graphNeighbors,
    });

    const hasAnyContext = items.length > 0;

    const sections: string[] = [
      `You are a Senior Software Engineer helping explain a codebase.`,
      ``,
      BASE_SOURCE_AUTHORITY,
      ``,
      `Give a clean, structured response without unnecessary symbols.`,
      ``,
      `Evidence handling:`,
      `- Sufficient evidence: when the material below directly answers the question, answer directly and confidently.`,
      `- Partial evidence: answer what's supported and explicitly say what isn't covered — don't fill the gap with generic textbook knowledge presented as this repository's actual behavior.`,
      `- Retrieved but not actually relevant: the material below was found by similarity search and isn't guaranteed to be relevant — if it doesn't actually address the question, say plainly that this repository's indexed content doesn't cover it, rather than stretching an unrelated snippet into an answer.`,
      `- Adjacent but wrong: retrieved material can be topically close without covering the SPECIFIC thing asked (e.g. access-token expiration code surfacing for a refresh-token expiration question — same family, different mechanism). Check that the evidence describes the specific thing asked about before asserting behavior from it; if it's adjacent but not exact, say what the evidence actually shows and flag that the specific case isn't directly covered, rather than assuming an adjacent mechanism behaves the same way.`,
      `- General/conceptual questions that don't depend on this specific repository: you may answer from general knowledge — say so plainly, and don't claim the repository demonstrates something the retrieved material doesn't actually show.`,
      `- Out-of-repository questions: give a brief, honest redirect rather than pretending to search.`,
      `- If documentation and code disagree about current behaviour, trust the code, and say plainly that the documentation appears out of date.`,
    ];

    if (!hasAnyContext) {
      // Previously this still instructed the model to cite sources over the
      // string "No specific code chunks retrieved." — which is what produced
      // confident-sounding "I have no access to your files" answers that
      // read like a broken integration rather than an empty search result.
      sections.push(
        ``,
        `No indexed content matched this question. Tell the user that directly:`,
        `nothing in the indexed repository matched, they could try rephrasing,`,
        `and the repository may still be finishing indexing. Do not speculate`,
        `about the codebase and do not cite any sources.`,
      );
    } else {
      sections.push(``, NUMBERED_CITATION_RULE, ``, promptText);
    }

    const systemPrompt = sections.join("\n");

    const displayable = items.filter((i) => i.displayable);
    const countOf = (kind: string) => displayable.filter((i) => i.kind === kind).length;

    // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
    // This is the last hop before the LLM: it proves which entries actually
    // reached the prompt, rather than merely being retrieved upstream.
    docRetrievalLog(
      `Q&A prompt assembled: ${displayable.length} numbered entr(y/ies) ` +
        `[code=${countOf("code")} (tier=${codeSectionTier}), doc=${countOf("documentation")} (tier=${docTier}), ` +
        `summary=${countOf("summary")} (arch tier=${architectureTier}, component tier=${componentTier}), ` +
        `imports=${countOf("imports")}], overview=${items.some((i) => !i.displayable) ? "yes" : "no"} ` +
        `(tier=${repositoryTier}), systemPrompt=${systemPrompt.length} chars total.` +
        (hasAnyContext ? "" : " NO CONTEXT — model instructed to say nothing matched."),
    );
    displayable.forEach((i) => docRetrievalLog(`  -> ${i.heading}${i.truncated ? " (truncated)" : ""}`));

    return {
      systemPrompt,
      promptContext: { version: 1, repoHtmlUrl: repo?.html_url ?? null, items },
      metadata: {
        repositoryId: session.repository_id,
        sourcesCount: displayable.length,
        codeSourcesCount: countOf("code"),
        docSourcesCount: countOf("documentation"),
        noContextFound: !hasAnyContext,
      },
    };
  }
}
