import type {
  ArchitectureSummary,
  ComponentSummary,
  RepositorySummary,
} from "../../../infrastructure/summarization/summaryTypes.js";
import type {
  CodeChunkSearchResult,
  DocChunkSearchResult,
  QAGraphNeighbors,
} from "../../../infrastructure/retrieval/retrievalTypes.js";
import { summaryBlockText } from "../../../shared/prompts/promptRendering.js";
import {
  ContextEntryDraft,
  PromptContextItem,
  renderBackgroundEntry,
  renderNumberedSection,
  stripChunkHeader,
} from "../../../shared/prompts/sourceRefs.js";

export type BudgetTier = "full" | "reduced" | "omit";

/**
 * Per-entry caps and per-section body budgets (characters). Same numbers the
 * provider used with renderCapped before numbered provenance; budgets now
 * count entry bodies only — see renderNumberedSection.
 */
const LIMITS = {
  overview: { full: 1200, reduced: 500 },
  architecture: { full: 1200, reduced: 500 },
  component: { each: 400, full: 1500, reduced: 600 },
  documentation: { each: 1200, full: 3000, reduced: 1200 },
  code: { each: 1500, full: 6000, reduced: 2500 },
  imports: { each: 3000 },
};

export interface QAPromptContextInput {
  repository: RepositorySummary | null;
  repositoryTier: BudgetTier;
  architecture: ArchitectureSummary | null;
  architectureTier: BudgetTier;
  components: ComponentSummary[];
  componentTier: BudgetTier;
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
 * Numbering is one continuous [1]..[k] sequence in PROMPT order, which is
 * chosen for answer quality (orientation first, then intent, then current
 * behaviour, then structure) and is independent of how the UI groups
 * sources. Each entry's heading carries its kind label, which is what carries
 * source authority to the model now that docs and code share one numbering.
 *
 * The repository overview is rendered unnumbered: it frames every question
 * the same way, so it's tracked in the snapshot but never offered as a
 * citable source.
 */
export function buildQAPromptContext(input: QAPromptContextInput): QAPromptContext {
  const sections: string[] = [];
  const items: PromptContextItem[] = [];
  let n = 1;

  const overviewBudget = budgetFor(input.repositoryTier, LIMITS.overview);
  if (input.repository && overviewBudget !== null) {
    const background = renderBackgroundEntry({
      meta: { kind: "summary", title: "Repository overview", summaryLevel: "repository" },
      heading: "Repository Overview (AI summary, background)",
      text: summaryBlockText(input.repository),
      maxChars: overviewBudget,
    });
    if (background) {
      sections.push(`## Repository Overview (background — not numbered, do not cite)\n${background.text}`);
      items.push(background.item);
    }
  }

  const archBudget = budgetFor(input.architectureTier, LIMITS.architecture);
  if (input.architecture && archBudget !== null) {
    const rendered = renderNumberedSection(
      [
        {
          meta: { kind: "summary", title: "Architecture", summaryLevel: "architecture" },
          heading: "AI SUMMARY · Architecture",
          text: summaryBlockText(input.architecture),
          maxChars: archBudget,
        },
      ],
      archBudget,
      n,
    );
    if (rendered.items.length > 0) {
      sections.push(`## Architecture\n${rendered.text}`);
      items.push(...rendered.items);
      n = rendered.nextN;
    }
  }

  const componentBudget = budgetFor(input.componentTier, LIMITS.component);
  if (input.components.length > 0 && componentBudget !== null) {
    const drafts: ContextEntryDraft[] = input.components.map((c) => {
      const title = c.name || "Component";
      return {
        meta: { kind: "summary", title, summaryLevel: "component" },
        heading: `AI SUMMARY · ${title} (component)`,
        text: summaryBlockText(c),
        maxChars: LIMITS.component.each,
      };
    });
    const rendered = renderNumberedSection(drafts, componentBudget, n);
    if (rendered.items.length > 0) {
      sections.push(`## Related Components\n${rendered.text}`);
      items.push(...rendered.items);
      n = rendered.nextN;
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
