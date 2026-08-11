import crypto from "crypto";
import { astChunker } from "./astChunking.service.js";
import { discoverModulesHeuristically, refineModulesWithLLM } from "./moduleDiscovery.service.js";
import {
  generateArchitectureSummary,
  generateComponentSummary,
  generateFileSummary,
  generateRepositorySummary,
} from "./summarizer.service.js";
import {embedSummary} from "../utils/embedUtil.js"
import type {
  ArchitectureSummary,
  ComponentSummary,
  EmbeddingClient,
  FileASTMetadata,
  FileSummary,
  // LLMClient,
  RepoFile,
  RepositorySummary,
  StoredSummaryRow,
  SummaryStore,
} from "../types/summaryTypes.js";
import { LLMService } from "./llm.service.js";

export interface PipelineDeps {
  llm: LLMService;
  embeddings: EmbeddingClient;
  store: SummaryStore;
  useLLMModuleRefinement?: boolean; // off by default — extra LLM call, only helps on messy repos
}

export interface PipelineInput {
  repositoryId: string;
  files: RepoFile[];
  readme: string | null;
  packageMetadata: Record<string, unknown> | null;
}

function hash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// Combines child hashes into one parent hash. Order-independent (sorted)
// so file-processing order never causes spurious "changed" detections.
function combineHashes(hashes: string[]): string {
  return hash([...hashes].sort().join("|"));
}

async function upsertIfChanged<T extends { nodeType: string }>(
  deps: PipelineDeps,
  repositoryId: string,
  nodeType: StoredSummaryRow["node_type"],
  nodeKey: string,
  parentKey: string | null,
  newContentHash: string,
  generate: () => Promise<T>,
): Promise<T> {
  const existing = await deps.store.get(repositoryId,nodeType, nodeKey);
  if (existing && existing.content_hash === newContentHash) {
    return existing.summary_json as unknown as T;
  }

  const summary = await generate();
  const embedding = await embedSummary(summary as any, deps.embeddings);

  await deps.store.upsert({
    repository_id: repositoryId,
    node_type: nodeType,
    node_key: nodeKey,
    parent_key: parentKey,
    summary_json: summary as any,
    content_hash: newContentHash,
    embedding,
  });

  return summary;
}

export async function runSummarizationPipeline(input: PipelineInput, deps: PipelineDeps): Promise<{
  fileSummaries: FileSummary[];
  componentSummaries: ComponentSummary[];
  architectureSummary: ArchitectureSummary;
  repositorySummary: RepositorySummary;
}> {
  const { repositoryId, files, readme, packageMetadata } = input;

  // --- Stage 1: AST extraction (repo code parsed exactly once here) ------
  const astMetadata: FileASTMetadata[] = [];
  const sourceByPath = new Map<string, string>();
  for (const file of files) {
    sourceByPath.set(file.path, file.source);
    const meta = await astChunker.extractFileAstMetadata(file.path, file.source);
    if (meta) astMetadata.push(meta);
  }

  // --- Stage 2: module discovery -----------------------------------------
  let assignments = discoverModulesHeuristically(astMetadata);
  if (deps.useLLMModuleRefinement) {
    assignments = await refineModulesWithLLM(assignments, astMetadata, deps.llm);
  }
  const moduleByPath = new Map(assignments.map((a) => [a.filePath, a.module]));

  const filesByModule = new Map<string, FileASTMetadata[]>();
  for (const meta of astMetadata) {
    const mod = moduleByPath.get(meta.filePath)!;
    if (!filesByModule.has(mod)) filesByModule.set(mod, []);
    filesByModule.get(mod)!.push(meta);
  }

  // --- Stage 3: file summaries (skip regeneration for unchanged files) ---
  const fileSummaries: FileSummary[] = [];
  const fileHashByPath = new Map<string, string>();

  for (const meta of astMetadata) {
    const module = moduleByPath.get(meta.filePath)!;
    const contentHash = meta.sourceHash; // file's own hash IS the source hash
    fileHashByPath.set(meta.filePath, contentHash);

    const summary = await upsertIfChanged(
      deps,
      repositoryId,
      "file",
      meta.filePath,
      module,
      contentHash,
      () => generateFileSummary(meta, sourceByPath.get(meta.filePath)!, module, deps.llm),
    );
    fileSummaries.push(summary);
  }

  // --- Stage 4: component summaries (built ONLY from file summaries) -----
  const componentSummaries: ComponentSummary[] = [];
  const componentHashByModule = new Map<string, string>();

  for (const [moduleName, moduleFiles] of filesByModule) {
    const childHashes = moduleFiles.map((f) => fileHashByPath.get(f.filePath)!);
    const componentHash = combineHashes(childHashes);
    componentHashByModule.set(moduleName, componentHash);

    const moduleFileSummaries = fileSummaries.filter((fs) => fs.module === moduleName);

    const summary = await upsertIfChanged(
      deps,
      repositoryId,
      "component",
      moduleName,
      "architecture",
      componentHash,
      () => generateComponentSummary(moduleName, moduleFileSummaries, deps.llm),
    );
    componentSummaries.push(summary);
  }

  // --- Stage 5: architecture summary (built ONLY from component summaries)
  const architectureHash = combineHashes([...componentHashByModule.values()]);
  const architectureSummary = await upsertIfChanged(
    deps,
    repositoryId,
    "architecture",
    "architecture",
    "repository",
    architectureHash,
    () => generateArchitectureSummary(componentSummaries, deps.llm),
  );

  // --- Stage 6: repository summary ----------------------------------------
  const repoHash = combineHashes([architectureHash, hash(readme ?? ""), hash(JSON.stringify(packageMetadata ?? {}))]);
  const repositorySummary = await upsertIfChanged(
    deps,
    repositoryId,
    "repository",
    "repository",
    null,
    repoHash,
    () => generateRepositorySummary(architectureSummary, componentSummaries, readme, packageMetadata, deps.llm),
  );

  return { fileSummaries, componentSummaries, architectureSummary, repositorySummary };
}