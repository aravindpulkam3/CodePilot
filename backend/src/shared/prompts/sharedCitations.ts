import { CodeChunkSearchResult, DocChunkSearchResult } from "../../infrastructure/retrieval/retrievalTypes.js";
import { truncate } from "./promptRendering.js";

/**
 * Shared between Q&A and Interview only — Review's citation convention
 * (a `// File: / // Symbol: / // Retrieved as:` comment-header style tied to
 * its five retrieval-class labels, plus an explicit PROVENANCE line) is a
 * genuinely different shape and stays independent in codeReviewPromptBuilder.ts;
 * forcing it into this module would be a worse fit than the two small
 * hand-written copies this module replaces.
 */
export const BASE_SOURCE_AUTHORITY = `Source authority:
- Documentation ([Doc N]) states the maintainer's documented intent, setup, and project description — authoritative for WHAT THE PROJECT IS FOR and HOW TO RUN IT.
- Code ([Source N]) is authoritative for WHAT THE SYSTEM ACTUALLY DOES TODAY.
- If documentation and code disagree, trust the code — and say so.`;

/**
 * [Doc N]: path § sectionPath\n<content>, truncated to keep one chunk from
 * blowing a block's budget. maxContentChars varies by call site (e.g.
 * Interview's turn-1 docBlock uses 1200, its follow-up grounding/stay blocks
 * use 1000) — not one fixed constant, so each caller passes its own.
 */
export function renderDocCitation(
  chunk: DocChunkSearchResult,
  index: number,
  maxContentChars: number = 1200,
  label: string = "Doc",
): string {
  return `[${label} ${index + 1}]: ${chunk.filePath} § ${chunk.sectionPath}\n${truncate(chunk.content, maxContentChars)}`;
}

/**
 * [Source N]: path (Lines a-b)\n```\n<content>\n```, truncated to keep one
 * chunk from blowing a block's budget. maxContentChars varies by call site
 * (e.g. Interview's grounding code uses 1500, its stay code uses 1200).
 */
export function renderCodeCitation(
  chunk: CodeChunkSearchResult,
  index: number,
  maxContentChars: number = 1500,
  label: string = "Source",
): string {
  return `[${label} ${index + 1}]: ${chunk.filePath} (Lines ${chunk.lineStart}-${chunk.lineEnd})\n\`\`\`\n${truncate(chunk.content, maxContentChars)}\n\`\`\``;
}
