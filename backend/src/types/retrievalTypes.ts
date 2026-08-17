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
  };
}

export interface RetrievalOptions {
  maxComponents?: number;
  maxFiles?: number;
  maxCodeChunks?: number;
  similarityThreshold?: number;
}
