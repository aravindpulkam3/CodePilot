import {
  ArchitectureSummary,
  ComponentSummary,
  FileSummary,
  RepositorySummary,
} from "./summaryTypes.js";

export type RetrievalMode = "qa" | "interview" | "review";

export interface SummarySearchResult {
  nodeType: "repository" | "architecture" | "component" | "file";
  nodeKey: string;
  parentKey: string | null;
  summary: RepositorySummary | ArchitectureSummary | ComponentSummary | FileSummary;
  similarity: number;
}

export interface CodeChunkSearchResult {
  filePath: string;
  symbolName: string;
  symbolType: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  similarity: number;
}

/**
 * A documentation (README) section retrieved from repository_embeddings.
 *
 * Structurally a code chunk plus its heading breadcrumb, but kept as a
 * DISTINCT type and a distinct field on RetrievedContext — never merged into
 * codeChunks. That separation is the mechanism for source authority: it is
 * what lets prompts label documentation differently from code and instruct
 * the model that docs are authoritative for intent/usage while code is
 * authoritative for current behaviour.
 */
export interface DocChunkSearchResult extends CodeChunkSearchResult {
  /** Heading breadcrumb, e.g. "Getting Started > Docker". */
  sectionPath: string;
}

export interface RetrievedContext {
  repository: RepositorySummary | null;
  architecture: ArchitectureSummary | null;
  components: ComponentSummary[];
  files: FileSummary[];
  codeChunks: CodeChunkSearchResult[];
  /** Documentation sections. Always present; empty when none matched. */
  docChunks: DocChunkSearchResult[];
  metadata: {
    mode: RetrievalMode;
    usedFallback: boolean;
    query: string;
    retrievalStage?: "start" | "follow_up";
    trace?: RetrievalTrace;
  };
}

/**
 * A repository area (a cluster of files under one `initialModuleFor` label),
 * with its files ranked by summed import fan-in. The Phase-1-only,
 * non-LLM orientation primitive that lets Interview ask a genuinely
 * repository-specific opening/NEW_TOPIC question with zero README/summaries
 * — see RepositoryRetrievalService#buildModuleInventory.
 */
export interface ModuleInventoryEntry {
  module: string;
  fileCount: number;
  /** Files in this module, highest import fan-in first. */
  files: string[];
}

export type InterviewGranularity = "REPOSITORY" | "MODULE" | "FILE";

/**
 * Interview start context — structural, Phase-1-only by default, and
 * DELIBERATELY carries zero code chunks.
 *
 * Retrieval used to seed the opening question with code chunks from
 * graph-fan-in "seed files" — architecturally central by fan-in, perhaps,
 * but structurally indistinguishable from arbitrary once retrieved, which is
 * exactly how the opening question ended up anchored on an arbitrary
 * low-level implementation detail instead of orienting the candidate. The
 * fix: code is fetched only once the interview's focus actually narrows to
 * FILE granularity (see InterviewFollowUpContext) — turn 1 always opens at
 * REPOSITORY scope, using only `moduleInventory` (real, Phase-1-only) plus
 * whatever of {repository, architecture, docChunks} happens to be available.
 * `repository`/`architecture` are enrichment, populated ONLY when
 * indexing_status === 'READY' (see retreival.service.ts).
 */
export interface InterviewStartContext {
  repository: RepositorySummary | null;
  architecture: ArchitectureSummary | null;
  moduleInventory: ModuleInventoryEntry[];
  docChunks: DocChunkSearchResult[];
  /** Every indexed file path — the closed list a (discouraged but not forbidden) turn-1 filePath declaration must resolve against. */
  contextPaths: string[];
  /** Every module name in moduleInventory — the closed list nextFocus.module must resolve against. */
  contextModules: string[];
}

/**
 * Interview follow-up context — granularity-keyed, not action-keyed (plan
 * v2 §5/§6). `granularity` is the CURRENT focus's granularity (i.e. what the
 * just-asked question — the one the candidate is now answering — was
 * actually scoped to), and drives all four blocks below identically; the
 * model's own `nextFocus` declaration (validated in interview.service.ts)
 * decides what actually happens next, retrieval only offers the menu:
 *
 * - grounding{Code,Docs,Summary}: keyed on the QUESTION vector, restricted to
 *   the CURRENT granularity's real material — code only at FILE, since a
 *   MODULE/REPOSITORY-scope question wasn't about specific code and there's
 *   nothing to check the answer against. Never keyed on the answer itself,
 *   since a wrong or "I don't know" answer would poison retrieval.
 * - stay{Code,Docs,Summary}: deeper material at the SAME granularity —
 *   feeds FOLLOW_UP/DEEP_DIVE/SIMPLIFY when they don't narrow.
 * - narrow{Modules,Files}: one level finer, offered ALONGSIDE stay (never
 *   instead of it) — feeds the same three actions when they DO narrow. Empty
 *   at FILE granularity (nothing finer to offer).
 * - frontierModules: unvisited-module coverage, names only. Feeds NEW_TOPIC,
 *   always assembled regardless of granularity — code is fetched for a
 *   frontier module only once a later turn's resolved focus actually
 *   narrows there to FILE.
 */
export interface InterviewFollowUpContext {
  granularity: InterviewGranularity;

  groundingCode: CodeChunkSearchResult[];
  groundingDocs: DocChunkSearchResult[];
  groundingSummary: RepositorySummary | ArchitectureSummary | ComponentSummary | null;

  stayCode: CodeChunkSearchResult[];
  stayDocs: DocChunkSearchResult[];
  staySummary: ArchitectureSummary | ComponentSummary | null;

  narrowModules: ModuleInventoryEntry[];
  narrowFiles: string[];

  frontierModules: ModuleInventoryEntry[];

  /** Union of file paths across all blocks — the closed list nextFocus.filePath must resolve against. */
  contextPaths: string[];
  /** Union of module names across all blocks — the closed list nextFocus.module must resolve against. */
  contextModules: string[];
  usedFallback: boolean;
}

export interface RetrievalOptions {
  maxComponents?: number;
  maxFiles?: number;
  maxCodeChunks?: number;
  similarityThreshold?: number;
  includeCode?: boolean;
  maxTokens?: number;
  /** Documentation sections to retrieve alongside code. */
  maxDocChunks?: number;
  /**
   * Threshold for documentation search, kept SEPARATE from
   * similarityThreshold and defaulting to the same value.
   *
   * Code chunks carry a synthetic "// File: / // Type: / // Name:" header
   * over a symbol span; README sections are natural-language prose. Embedded
   * under asymmetric task types (RETRIEVAL_QUERY for the question,
   * RETRIEVAL_DOCUMENT for the stored text), a natural-language question
   * plausibly scores differently against prose than against code. They ship
   * identical for consistency, but retuning documentation later must not
   * require moving the shared threshold — hence the separate knob.
   */
  docSimilarityThreshold?: number;
}

/**
 * How a candidate was found. Every one of these is now REACHABLE — the union
 * previously carried five members nothing emitted.
 *
 * Removed, and why:
 * - `exact_symbol` / `cross_file_symbol_match`: produced by a symbol-name
 *   lookup that matched `symbol_name` exactly, repo-wide, unindexed. Split
 *   symbols are stored as "foo (part 2/3)" so they never matched, while
 *   basename-fallback chunks made `index.ts` match every index.ts in the repo.
 *   Subsumed by `changed_file` — for a changed file, "the definition of a
 *   symbol in it" IS "a chunk of it", now properly ranked.
 * - `semantic_summary`: fed LLM prose into a block the prompt calls code, and
 *   was sourced from Phase-2-only data.
 * - `graph_parent_component` / `graph_child_file`: never emitted, and would
 *   have to read `repository_summaries.parent_key` (Phase 2 only), which is
 *   exactly the SEARCHABLE-emptiness problem this design removes.
 */
export type CandidateSourceType =
  | "changed_file"
  | "related_test"
  | "graph_dependent"
  | "graph_dependency"
  | "semantic_chunk";

export interface CandidateSource {
  type: CandidateSourceType;
  weight: number;
  // How confident THIS source is that the candidate is relevant (0-1).
  // For structural/exact sources (graph, exact_symbol, tests) this is
  // always 1.0 — finding them is certain, only their relevance to the
  // query varies, which the weight already encodes. For semantic sources
  // this is the actual cosine similarity, so two chunks found via the same
  // source type can still be ranked against each other instead of tying.
  similarity: number;
}

export interface RetrievalCandidate {
  // Identity key for deduplication. 
  // For files/summaries: The file path or component name
  // For chunks: The file_path#content_hash or file_path#start_line
  identityKey: string;
  
  // The retrieved text content
  content: string;
  
  // What kind of data this is
  // Only "code_chunk" is produced. The union previously carried three other
  // arms; "file_summary" was the prose path that never reached the prompt,
  // and the other two were never constructed at all.
  dataType: "code_chunk";
  
  // Provenance of why this was retrieved
  sources: CandidateSource[];
  
  // The final aggregated score after reranking
  score: number;
  
  // Metadata for rendering/attribution
  metadata: {
    filePath?: string;
    componentName?: string;
    startLine?: number;
    endLine?: number;
    symbolName?: string;
  };
}

/**
 * Weights applied deterministically based on how the context was found.
 *
 * These are multiplied by a REAL cosine similarity now. Previously the
 * structural retrievers hardcoded `similarity: 1.0`, so every candidate of a
 * given type scored exactly its weight — producing mass ties that a stable
 * sort resolved by graph-traversal order (itself nondeterministic under
 * indexQueue's concurrency: 4). Retrieving structural context through pgvector
 * gives every candidate a real score, and the tie problem disappears without
 * any extra ranking machinery.
 */
export const RETRIEVAL_WEIGHTS: Record<CandidateSourceType, number> = {
  changed_file: 1.0,      // A chunk of a file the PR actually modifies
  related_test: 0.85,     // A test covering a changed file — encodes intended behaviour
  graph_dependent: 0.8,   // CALLERS: who breaks when this changes. For review this
                          // outranks dependencies — the previous ordering had it
                          // backwards (dependency 0.8 > dependent 0.75).
  graph_dependency: 0.65, // Callees: relevant, but the diff usually shows the call site
  semantic_chunk: 0.45    // Raised: now the only general-recall path, no longer
                          // competing against constant-1.0 structural scores
};

/** How much a secondary source adds once the strongest one is counted. */
export const CORROBORATION_FACTOR = 0.25;

export interface DroppedCandidate {
  identityKey: string;
  reason: "budget_capped" | "deduplicated" | "low_score";
}

export interface RetrievalTrace {
  timingMs: {
    /** Stage A: resolving the structural file set from the import graph. */
    graphExpansion: number;
    /** Stages B-D: fetching chunks for each class, plus documentation. */
    semanticRetrieval: number;
    mergeAndRerank: number;
    budgetAllocation: number;
    total: number;
  };
  counts: {
    changedFile: number;
    graphDependency: number;
    graphDependent: number;
    relatedTest: number;
    semantic: number;
    totalPreMerge: number;
    totalPostMerge: number;
    finalAccepted: number;
  };
  /** Files resolved per structural class, before any chunk was fetched. */
  fileSets?: {
    changed: number;
    tests: number;
    dependents: number;
    dependencies: number;
    fanInSuppressed: string[];
  };
  budget: {
    changedCodeTokens: number;
    graphTokens: number;
    testTokens: number;
    semanticTokens: number;
    totalTokens: number;
  };
  droppedCandidates: DroppedCandidate[];
}
