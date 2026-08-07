import type { FileASTMetadata } from "../services/astChunking.service.js";

export type { FileASTMetadata };

export interface FileSummary {
  nodeType: "file";
  name: string;
  path: string;
  module: string;
  purpose: string;
  summary: string;
  responsibilities: string[];
  technologies: string[];
  keywords: string[];
  importantClasses: string[];
  importantFunctions: string[];
  externalDependencies: string[];
  internalDependencies: string[];
}

export interface ComponentSummary {
  nodeType: "component";
  name: string;
  summary: string;
  purpose: string;
  responsibilities: string[];
  technologies: string[];
  keywords: string[];
  importantFiles: string[];
  publicInterfaces: string[];
  relatedComponents: string[];
}

export interface ArchitectureSummary {
  nodeType: "architecture";
  summary: string;
  architectureStyle: string;
  majorLayers: string[];
  majorFlows: string[];
  majorComponents: string[];
  crossCuttingConcerns: string[];
  technologies: string[];
  keywords: string[];
}

export interface RepositorySummary {
  nodeType: "repository";
  summary: string;
  purpose: string;
  features: string[];
  techStack: string[];
  keywords: string[];
}

export type SummaryJSON = FileSummary | ComponentSummary | ArchitectureSummary | RepositorySummary;
export type NodeType = SummaryJSON["nodeType"];

// One row per node. `content_hash` is the one deliberate addition beyond the
// spec's column list — it's what makes "never regenerate unchanged nodes"
// an actual behavior instead of just an intention. See pipeline.ts.
export interface StoredSummaryRow {
  id: string;
  repository_id: string;
  node_type: NodeType;
  node_key: string; // file path | module name | "architecture" | "repository"
  parent_key: string | null;
  summary_json: SummaryJSON;
  content_hash: string;
  embedding: number[];
  created_at: string;
  updated_at: string;
}

// --- Pluggable clients (bring your own provider) --------------------------

export interface LLMClient {
  /** Must return parsed JSON matching the shape the prompt asked for. */
  generateJSON<T>(system: string, prompt: string): Promise<T>;
}

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export interface SummaryStore {
  get(repositoryId: string, nodeKey: string): Promise<StoredSummaryRow | null>;
  upsert(row: Omit<StoredSummaryRow, "id" | "created_at" | "updated_at">): Promise<void>;
}

export interface RepoFile {
  path: string; // repo-relative, e.g. "src/services/authService.ts"
  source: string;
}