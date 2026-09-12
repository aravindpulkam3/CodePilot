// Mirrors backend/src/shared/prompts/sourceRefs.ts#SourceRef — the display
// DTO for context that was actually supplied to the model. The backend's
// authoritative prompt-context snapshot never reaches the client; these are
// derived from it server-side.

export type SourceKind = "code" | "imports" | "documentation" | "summary";

/** "exact" = from the persisted prompt snapshot; "legacy" = saved before exact tracking. */
export type SourcesProvenance = "exact" | "legacy";

export interface ImportRelations {
  anchor: string;
  dependencies: string[];
  dependents: string[];
}

export interface SourceRef {
  /** The [n] number the model saw and cites. */
  n: number;
  kind: SourceKind;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  /** File line of the excerpt's first line; absent when the excerpt isn't file-aligned. */
  excerptStartLine?: number;
  section?: string;
  title?: string;
  summaryLevel?: "component" | "architecture";
  imports?: ImportRelations;
  /** Exactly what the model was shown for this entry. */
  excerpt: string;
  truncated: boolean;
  commitSha?: string;
  url?: string;
}
