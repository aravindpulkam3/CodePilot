import type {
  CodeChunkSearchResult,
  DocChunkSearchResult,
  QAGraphNeighbors,
} from "../../../infrastructure/retrieval/retrievalTypes.js";
import {
  ContextEntryDraft,
  PromptContextItem,
  renderBackgroundEntry,
  renderNumberedSection,
  stripChunkHeader,
} from "../../../shared/prompts/sourceRefs.js";
import { BASE_SOURCE_AUTHORITY, NUMBERED_CITATION_RULE } from "../../../shared/prompts/sharedCitations.js";

export type BudgetTier = "full" | "reduced" | "omit";

/**
 * Per-entry caps and per-section body budgets (characters). Budgets count
 * entry bodies only — see renderNumberedSection.
 */
const LIMITS = {
  overview: { full: 1200, reduced: 500 },
  documentation: { each: 1200, full: 3000, reduced: 1200 },
  code: { each: 1500, full: 6000, reduced: 2500 },
  imports: { each: 3000 },
};

export interface QAPromptContextInput {
  /** Deterministic repository profile text (repositoryMap.service.ts). */
  repositoryProfile: string | null;
  repositoryTier: BudgetTier;
  docChunks: DocChunkSearchResult[];
  docTier: BudgetTier;
  codeChunks: CodeChunkSearchResult[];
  codeTier: BudgetTier;
  graphNeighbors?: QAGraphNeighbors | null;
}

export interface QAPromptContext {
  /** Every context section, ready to append to the system prompt ("" when nothing). */
  promptText: string;
  /** Exactly the entries in promptText, numbered and background alike. */
  items: PromptContextItem[];
}

function budgetFor(tier: BudgetTier, limits: { full: number; reduced: number }): number | null {
  if (tier === "omit") return null;
  return tier === "full" ? limits.full : limits.reduced;
}

function importRelationsText(gn: QAGraphNeighbors): string {
  const lines: string[] = [];
  if (gn.dependents.length > 0) lines.push(`Imported by: ${gn.dependents.join(", ")}`);
  if (gn.dependencies.length > 0) lines.push(`Imports: ${gn.dependencies.join(", ")}`);
  return lines.join("\n");
}

/**
 * Renders Q&A's retrieved context into numbered prompt entries and returns
 * the provenance for exactly what was rendered.
 *
 * Numbering is one continuous [1]..[k] sequence in PROMPT order (intent, then
 * current behaviour, then structure), independent of how the UI groups
 * sources. Each entry's heading carries its kind label, which is what carries
 * source authority to the model now that docs and code share one numbering.
 *
 * The repository profile is rendered unnumbered: it frames every question the
 * same way, so it's tracked in the snapshot but never offered as a citable
 * source.
 */
export function buildQAPromptContext(input: QAPromptContextInput): QAPromptContext {
  const sections: string[] = [];
  const items: PromptContextItem[] = [];
  let n = 1;

  const overviewBudget = budgetFor(input.repositoryTier, LIMITS.overview);
  if (input.repositoryProfile && overviewBudget !== null) {
    const background = renderBackgroundEntry({
      meta: { kind: "summary", title: "Repository profile", summaryLevel: "repository" },
      heading: "Repository Overview (derived from paths, imports and manifests; background)",
      text: input.repositoryProfile,
      maxChars: overviewBudget,
    });
    if (background) {
      sections.push(`## Repository Overview (background — not numbered, do not cite)\n${background.text}`);
      items.push(background.item);
    }
  }

  const docBudget = budgetFor(input.docTier, LIMITS.documentation);
  if (input.docChunks.length > 0 && docBudget !== null) {
    const drafts: ContextEntryDraft[] = input.docChunks.map((d) => ({
      meta: {
        kind: "documentation",
        filePath: d.filePath,
        section: d.sectionPath,
        lineStart: d.lineStart,
        lineEnd: d.lineEnd,
        symbolType: d.symbolType,
        commitSha: d.commitSha,
      },
      heading: `DOCUMENTATION · ${d.filePath} § ${d.sectionPath}`,
      text: stripChunkHeader(d.content),
      maxChars: LIMITS.documentation.each,
    }));
    const rendered = renderNumberedSection(drafts, docBudget, n);
    if (rendered.items.length > 0) {
      sections.push(`## Documentation\n${rendered.text}`);
      items.push(...rendered.items);
      n = rendered.nextN;
    }
  }

  const codeBudget = budgetFor(input.codeTier, LIMITS.code);
  if (input.codeChunks.length > 0 && codeBudget !== null) {
    const drafts: ContextEntryDraft[] = input.codeChunks.map((c) => ({
      meta: {
        kind: "code",
        filePath: c.filePath,
        symbol: c.symbolName,
        symbolType: c.symbolType,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        commitSha: c.commitSha,
      },
      heading: `CODE · ${c.filePath} · ${c.symbolName} · lines ${c.lineStart}-${c.lineEnd}`,
      text: stripChunkHeader(c.content),
      maxChars: LIMITS.code.each,
      truncateAtLine: true,
      fenced: true,
    }));
    const rendered = renderNumberedSection(drafts, codeBudget, n);
    if (rendered.items.length > 0) {
      sections.push(`## Code\n${rendered.text}`);
      items.push(...rendered.items);
      n = rendered.nextN;
    }
  }

  // Import relationships — already gated upstream (single anchor, single
  // hop, strict absolute similarity floor), so no tiering here.
  const gn = input.graphNeighbors;
  if (gn && (gn.dependencies.length > 0 || gn.dependents.length > 0)) {
    const rendered = renderNumberedSection(
      [
        {
          meta: {
            kind: "imports",
            filePath: gn.anchorFile,
            imports: { anchor: gn.anchorFile, dependencies: gn.dependencies, dependents: gn.dependents },
          },
          heading: `IMPORT RELATIONSHIPS · ${gn.anchorFile}`,
          text: importRelationsText(gn),
          maxChars: LIMITS.imports.each,
        },
      ],
      LIMITS.imports.each,
      n,
    );
    if (rendered.items.length > 0) {
      sections.push(
        `## Import relationships\n` +
          `Structural evidence only — file names from import statements, not code. Mention only if relevant to the question; don't describe contents that weren't actually shown to you.\n` +
          rendered.text,
      );
      items.push(...rendered.items);
      n = rendered.nextN;
    }
  }

  return { promptText: sections.join("\n\n"), items };
}

export interface QASystemPrompt {
  systemPrompt: string;
  /**
   * At least one numbered, citable entry (code, documentation or import
   * relationships) reached the prompt. The unnumbered Repository Overview
   * never counts: it is orientation, not evidence.
   */
  hasCitableEvidence: boolean;
}

/**
 * Assembles the Q&A system prompt around a rendered context. Only citable
 * entries decide which instruction the model gets: with none, it is told that
 * nothing matched, even when the Repository Overview is present — the
 * overview is then appended as orientation only.
 */
export function buildQASystemPrompt({ promptText, items }: QAPromptContext): QASystemPrompt {
  const hasCitableEvidence = items.some((i) => i.displayable);

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

  if (!hasCitableEvidence) {
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
    // Numbered sections render only when they have entries, so all that can
    // remain here is the unnumbered overview.
    if (promptText) {
      sections.push(
        ``,
        `The Repository Overview below is background orientation only, not evidence for how anything is implemented. You may use it for a high-level statement about what the project is or how it is organised — say that it comes from the overview — but not for implementation details.`,
        ``,
        promptText,
      );
    }
  } else {
    sections.push(``, NUMBERED_CITATION_RULE, ``, promptText);
  }

  return { systemPrompt: sections.join("\n"), hasCitableEvidence };
}
