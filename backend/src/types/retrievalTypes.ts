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

export interface RetrievedContext {
  repository: RepositorySummary | null;
  architecture: ArchitectureSummary | null;
  components: ComponentSummary[];
  files: FileSummary[];
  codeChunks: CodeChunkSearchResult[];
  metadata: {
    mode: RetrievalMode;
    usedFallback: boolean;
    query: string;
    retrievalStage?: "start" | "follow_up";
    trace?: RetrievalTrace;
  };
}

export interface RetrievalOptions {
  maxComponents?: number;
  maxFiles?: number;
  maxCodeChunks?: number;
  similarityThreshold?: number;
  includeCode?: boolean;
  maxTokens?: number;
}

export type CandidateSourceType =
  | "semantic_summary"
  | "semantic_chunk"
  | "graph_dependency"
  | "graph_dependent"
  | "graph_parent_component"
  | "graph_child_file"
  | "exact_symbol"
  | "cross_file_symbol_match"
  | "changed_file"
  | "related_test";

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
  dataType: "file_summary" | "component_summary" | "code_chunk" | "file_content";
  
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

// Weights applied deterministically based on how the context was found
export const RETRIEVAL_WEIGHTS: Record<CandidateSourceType, number> = {
  changed_file: 1.0,           // The actual changed file
  exact_symbol: 0.9,           // A symbol explicitly changed in the diff
  cross_file_symbol_match: 0.35, // Same symbol NAME found elsewhere in the repo —
                                  // no call graph to confirm it's actually related,
                                  // so treated as a weak/coincidental signal, not
                                  // an authoritative match.
  related_test: 0.85,          // A test covering a changed file
  graph_dependency: 0.8,       // What the changed file imports
  graph_dependent: 0.75,       // What imports the changed file
  graph_parent_component: 0.6, // The parent architecture component
  graph_child_file: 0.5,       // A file within a retrieved component
  semantic_summary: 0.4,       // Matched via vector search on summaries
  semantic_chunk: 0.3          // Matched via vector search on chunks
};

export interface DroppedCandidate {
  identityKey: string;
  reason: "budget_capped" | "deduplicated" | "low_score";
}

export interface RetrievalTrace {
  timingMs: {
    changedAnalysis: number;
    exactSymbol: number;
    graphExpansion: number;
    semanticRetrieval: number;
    mergeAndRerank: number;
    budgetAllocation: number;
    total: number;
  };
  counts: {
    exactSymbol: number;
    graphDependency: number;
    graphDependent: number;
    relatedTest: number;
    semantic: number;
    totalPreMerge: number;
    totalPostMerge: number;
    finalAccepted: number;
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
