import { CodeChunkSearchResult, DocChunkSearchResult } from "../../infrastructure/retrieval/retrievalTypes.js";
import { truncate } from "./promptRendering.js";

/**
 * BASE_SOURCE_AUTHORITY / NUMBERED_CITATION_RULE are Q&A's: its context is one
 * unified [n] numbering, with each entry's kind label (CODE / DOCUMENTATION /
 * IMPORT RELATIONSHIPS) carrying source authority — see
 * features/chat/providers/qaPromptContext.ts.
 *
 * renderDocCitation / renderCodeCitation are Interview's — its [Doc N] /
 * [Source N] / [Stay N] labels are part of live-verified prompt wording and
 * are deliberately unchanged.
 *
 * Review's citation convention (a `// File: / // Symbol: / // Retrieved as:`
 * comment-header style tied to its five retrieval-class labels, plus an
 * explicit PROVENANCE line) is a genuinely different shape and stays
 * independent in codeReviewPromptBuilder.ts.
 */
export const BASE_SOURCE_AUTHORITY = `Source authority:
- DOCUMENTATION entries state the maintainer's documented intent, setup, and project description — authoritative for WHAT THE PROJECT IS FOR and HOW TO RUN IT.
- CODE entries are authoritative for WHAT THE SYSTEM ACTUALLY DOES TODAY.
- DOCUMENTATION entries for manifest and config files (package.json, docker-compose, Dockerfile, .env.example, tsconfig, SQL schema) are authoritative for DECLARED DEPENDENCIES, RUNTIME SERVICES, REQUIRED ENVIRONMENT VARIABLES and SETUP.
- The unnumbered Repository Overview is derived from file paths, imports and manifests — orientation only, never cite it.
- IMPORT RELATIONSHIPS entries are file-level structure taken from import statements (names only, possibly incomplete) — never describe a file's contents from them.
- If documentation and code disagree, trust the code — and say so.`;

export const NUMBERED_CITATION_RULE = `Citations: when a statement relies on a numbered context entry, cite it inline with its number in square brackets, e.g. "requireAuth validates the token [2]" or "[1][3]". Use only the numbers shown on the entries below — never invent a number, and never cite unnumbered background such as the Repository Overview.`;

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
