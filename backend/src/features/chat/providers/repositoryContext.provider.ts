import { ChatContextProvider, ChatContextPayload, ChatSessionRecord, ConversationContext } from "../chat.types.js";
import { retrievalService } from "../../../infrastructure/retrieval/retreival.service.js";
import { findRepositoryById } from "../../repository/repository.service.js";
import { buildQAPromptContext, buildQASystemPrompt, BudgetTier } from "./qaPromptContext.js";
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
/** "Unambiguously strong in its own right" — lets a doc section win full budget even alongside solid code. */
const STRONG_MARGIN = 0.15;

/**
 * Decides how much prompt budget the documentation section earns THIS turn — not "non-empty," a relative judgment against
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
function docTierGivenCode(ownSimilarity: number | null, codeMargin: number): BudgetTier {
  if (ownSimilarity === null) return "omit";
  const ownMargin = ownSimilarity - BASE_THRESHOLD;
  const codeIsSolid = codeMargin >= SOLID_MARGIN;
  if (!codeIsSolid) return "full";
  if (ownMargin >= STRONG_MARGIN) return "full";
  return "reduced";
}

/**
 * Code's own tier never depends on comparing its raw score against docs —
 * its role (authoritative for current behaviour) means it gets
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

    const sim = retrieved.metadata.evidenceSimilarities ?? { doc: null, code: null };

    // Relevance-and-role weighting: which sections get full budget, reduced
    // budget, or are omitted this turn. codeMargin drives the other sections'
    // tiers (asymmetric — code's role as "authoritative for current
    // behaviour" means it isn't crowded out by a docs section that merely
    // scored a marginally higher raw number); code's own tier never looks at
    // the others. See docTierGivenCode/codeTier for the exact rule.
    const codeMargin = (sim.code ?? -Infinity) - BASE_THRESHOLD;
    const docTier = docTierGivenCode(sim.doc, codeMargin);
    const codeSectionTier = codeTier(sim.code);
    // The repository profile is not retrieved by similarity, so it has no
    // score of its own: full budget for broad questions (code not a solid
    // match), reduced alongside a solid code answer.
    const repositoryTier: BudgetTier = codeMargin >= SOLID_MARGIN ? "reduced" : "full";

    // One numbered [n] list across every evidence type, rendered and
    // recorded in the same pass — the snapshot below is exactly what the
    // prompt contains, including which entries the budgets skipped (absent)
    // and which were truncated. Docs and code keep distinct kind labels,
    // which is what carries source authority now that they share numbering.
    const qaContext = buildQAPromptContext({
      repositoryProfile: retrieved.repositoryProfile,
      repositoryTier,
      docChunks: retrieved.docChunks || [],
      docTier,
      codeChunks: retrieved.codeChunks || [],
      codeTier: codeSectionTier,
      graphNeighbors: retrieved.graphNeighbors,
    });
    const { items } = qaContext;

    // Only numbered entries count as evidence: an overview-only context still
    // gets the "nothing matched" instruction (see buildQASystemPrompt).
    const { systemPrompt, hasCitableEvidence } = buildQASystemPrompt(qaContext);

    const displayable = items.filter((i) => i.displayable);
    const countOf = (kind: string) => displayable.filter((i) => i.kind === kind).length;

    // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
    // This is the last hop before the LLM: it proves which entries actually
    // reached the prompt, rather than merely being retrieved upstream.
    docRetrievalLog(
      `Q&A prompt assembled: ${displayable.length} numbered entr(y/ies) ` +
        `[code=${countOf("code")} (tier=${codeSectionTier}), doc=${countOf("documentation")} (tier=${docTier}), ` +
        `imports=${countOf("imports")}], overview=${items.some((i) => !i.displayable) ? "yes" : "no"} ` +
        `(tier=${repositoryTier}), systemPrompt=${systemPrompt.length} chars total.` +
        (hasCitableEvidence ? "" : " NO CITABLE EVIDENCE — model instructed to say nothing matched."),
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
        noContextFound: !hasCitableEvidence,
      },
    };
  }
}
