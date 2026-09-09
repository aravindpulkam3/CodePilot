import { ChatContextProvider, ChatContextPayload, ChatSessionRecord, ConversationContext } from "../chat.types.js";
import { retrievalService } from "../../../infrastructure/retrieval/retreival.service.js";
import { truncate, renderCapped, renderSummaryBlock } from "../../../shared/prompts/promptRendering.js";
import { BASE_SOURCE_AUTHORITY, renderDocCitation, renderCodeCitation } from "../../../shared/prompts/sharedCitations.js";
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

type BudgetTier = "full" | "reduced" | "omit";

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
    // into the returned context below.
    const retrieved = await retrievalService.retrieveQAContext(
      clerkUserId,
      session.repository_id,
      userMessage,
      undefined,
      conversation
        ? { isNewSession: conversation.isNewSession, recentHistory: conversation.recentHistory }
        : undefined
    );

    const codeChunks = retrieved.codeChunks || [];
    const docChunks = retrieved.docChunks || [];
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
    const repoTier = summaryTierGivenCode(sim.repository, codeMargin);
    const archTier = summaryTierGivenCode(sim.architecture, codeMargin);
    const componentTier = summaryTierGivenCode(sim.component, codeMargin);
    const docTier = summaryTierGivenCode(sim.doc, codeMargin);
    const codeSectionTier = codeTier(sim.code);

    // Documentation and code are numbered in SEPARATE citation namespaces
    // ([Doc N] vs [Source N]). That distinction is what carries source
    // authority through to the answer — the model can tell the user which
    // of its claims came from the maintainer's prose and which from the
    // code.
    const docContext =
      docTier === "omit"
        ? ""
        : renderCapped(docChunks, (d, i) => renderDocCitation(d, i), docTier === "full" ? 3000 : 1200);

    const codeContext =
      codeSectionTier === "omit"
        ? ""
        : renderCapped(codeChunks, (s, i) => renderCodeCitation(s, i), codeSectionTier === "full" ? 6000 : 2500);

    const overview =
      repoTier === "omit"
        ? ""
        : renderSummaryBlock(retrieved.repository, repoTier === "full" ? 1200 : 500);

    const architectureBlock =
      archTier === "omit"
        ? ""
        : renderSummaryBlock(retrieved.architecture, archTier === "full" ? 1200 : 500);

    const componentsBlock =
      componentTier === "omit" || retrieved.components.length === 0
        ? ""
        : renderCapped(
            retrieved.components,
            (c) => renderSummaryBlock(c, 400),
            componentTier === "full" ? 1500 : 600,
          );

    // Graph augmentation ("what depends on X") — already gated on a strict,
    // absolute, code-only similarity floor upstream in retrieveQAContext
    // (not part of the relevance-and-role weighting above), so no separate
    // tiering needed here: if it's present at all, it's already confident
    // and bounded (single anchor file, single hop, capped neighbor count).
    const graphBlock = (() => {
      const gn = retrieved.graphNeighbors;
      if (!gn) return "";
      const lines: string[] = [`Anchor: ${gn.anchorFile}`];
      if (gn.dependencies.length > 0) lines.push(`Depends on: ${gn.dependencies.join(", ")}`);
      if (gn.dependents.length > 0) lines.push(`Depended on by: ${gn.dependents.join(", ")}`);
      return lines.join("\n");
    })();

    const hasAnyContext = Boolean(overview || architectureBlock || componentsBlock || docContext || codeContext || graphBlock);

    const sections: string[] = [
      `You are a Senior Software Engineer helping explain a codebase.`,
      ``,
      BASE_SOURCE_AUTHORITY,
      ``,
      `Cite sources as [Doc N] or [Source N] when referring to specific files or logic.`,
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
      if (architectureBlock) sections.push(``, `## Architecture`, architectureBlock);
      if (componentsBlock) sections.push(``, `## Related Components`, componentsBlock);
      if (docContext) sections.push(``, `## Documentation`, docContext);
      if (codeContext) sections.push(``, `## Code`, codeContext);
      if (graphBlock) {
        sections.push(
          ``,
          `## Related files (import graph)`,
          `Structural evidence only — names, not code. Mention only if relevant to the question; don't describe contents that weren't actually shown to you.`,
          graphBlock,
        );
      }
    }

    const systemPrompt = sections.join("\n");

    // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
    // This is the last hop before the LLM: it proves documentation actually
    // reached the prompt, rather than merely being retrieved upstream.
    docRetrievalLog(
      `Q&A prompt assembled: ${docChunks.length} [Doc] block(s) (tier=${docTier}), ` +
        `${codeChunks.length} [Source] block(s) (tier=${codeSectionTier}), ` +
        `overview=${overview ? "yes" : "no"} (tier=${repoTier}), architecture=${architectureBlock ? "yes" : "no"} (tier=${archTier}), ` +
        `components=${componentsBlock ? "yes" : "no"} (tier=${componentTier}), graph=${graphBlock ? "yes" : "no"}, ` +
        `systemPrompt=${systemPrompt.length} chars total.` +
        (hasAnyContext ? "" : " NO CONTEXT — model instructed to say nothing matched."),
    );

    // Both kinds go to the client as sources, tagged so the UI can render a
    // README section differently from a code span. Excluded only when a
    // whole section was omitted by its tier (the model saw none of it) —
    // NOT reconciled against renderCapped's item-level cutoff at "reduced"
    // budget, so a reduced section can show one or two more badges than
    // strictly made it into the rendered text. Accepted, not fixed: these
    // still represent real retrieved evidence for this question, and this
    // provider already treats badges as "what was searched," not "what was
    // literally quoted" (see the citation-spam tradeoff in the Q&A plan).
    const sources = [
      ...(docTier === "omit" ? [] : docChunks).map((d) => ({ ...d, sourceKind: "documentation" as const })),
      ...(codeSectionTier === "omit" ? [] : codeChunks).map((c) => ({ ...c, sourceKind: "code" as const })),
    ];

    return {
      systemPrompt,
      sources,
      metadata: {
        repositoryId: session.repository_id,
        sourcesCount: sources.length,
        codeSourcesCount: codeSectionTier === "omit" ? 0 : codeChunks.length,
        docSourcesCount: docTier === "omit" ? 0 : docChunks.length,
        noContextFound: !hasAnyContext,
      },
    };
  }
}
