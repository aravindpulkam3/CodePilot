import { repositorySyncService } from "./repositorySync.service.js";
import { syncQueue } from "../config/queues.js";
import {
  CodeChunkSearchResult,
  RetrievalCandidate,
  RetrievalOptions,
  RetrievedContext,
  RetrievalTrace,
  RETRIEVAL_WEIGHTS,
} from "../types/retrievalTypes.js";
import {
  ComponentSummary,
  FileSummary,
} from "../types/summaryTypes.js";

import { semanticRetrievalService } from "./semanticRetrieval.service.js";
import { repositoryGraphService } from "./repositoryGraph.service.js";
import { symbolRetrievalService } from "./symbolRetrieval.service.js";
import { relatedTestDiscoveryService } from "./relatedTestDiscovery.service.js";
import { changedSymbolAnalysisService } from "./changedSymbolAnalysis.service.js";
import { candidateMergerService } from "./candidateMerger.service.js";
import { retrievalRerankerService } from "./retrievalReranker.service.js";
import { contextBudgetService } from "./contextBudget.service.js";
import { performance } from "perf_hooks";

const DEFAULT_OPTIONS: RetrievalOptions = {
  maxComponents: 3,
  maxFiles: 5,
  maxCodeChunks: 10,
  similarityThreshold: 0.6,
  maxTokens: 15000,
};

export class RepositoryRetrievalService {
  private async ensureSynced(clerkUserId: string, repositoryId: string) {
    console.log(`[RetrievalService] Triggering JIT Sync check for repository ${repositoryId}...`);

    const maxWaitMs = 45000;
    const pollIntervalMs = 2000;
    const startTime = Date.now();
    const deadline = () => Date.now() - startTime < maxWaitMs;

    // 1. Enqueue the sync job, then wait for THIS job to finish (not just any past
    // state) before looking at indexing_status — the repo can already read 'INDEXED'
    // from a previous sync while this job is still sitting in the queue.
    const { jobId } = await repositorySyncService.enqueueSync(clerkUserId, repositoryId);
    const job = jobId ? await syncQueue.getJob(jobId) : undefined;

    if (job) {
      while (deadline()) {
        const state = await job.getState();
        if (state === "completed" || state === "failed" || state === "unknown") break;
        await new Promise((res) => setTimeout(res, pollIntervalMs));
      }
    }

    // 2. The sync job only enqueues indexing chunks; it doesn't wait for them.
    // Poll the repo's indexing_status until the index worker finishes (or fails/times out).
    const { pool } = await import("../config/db.js");

    while (deadline()) {
      const { rows } = await pool.query(
        "SELECT indexing_status FROM repositories WHERE id = $1",
        [repositoryId]
      );

      const status = rows[0]?.indexing_status;
      if (status === 'INDEXED' || status === 'FAILED' || !status) {
        break; // It's done, failed, or was never indexed to begin with.
      }

      await new Promise(res => setTimeout(res, pollIntervalMs));
    }

    console.log(`[RetrievalService] Sync wait completed. Proceeding to semantic retrieval...`);
  }

  // --- QA Mode (Legacy behavior preserved) ---
  public async retrieveQAContext(clerkUserId: string, repositoryId: string, query: string, opts?: RetrievalOptions): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSynced(clerkUserId, repositoryId);

    const queryVectorStr = await semanticRetrievalService.getQueryVectorStr(query);

    const context: RetrievedContext = {
      repository: null,
      architecture: null,
      components: [],
      files: [],
      codeChunks: [],
      metadata: { mode: "qa", usedFallback: false, query },
    };

    const summaryResults = await semanticRetrievalService.searchSummaries(
      repositoryId,
      queryVectorStr,
      undefined,
      10,
      options.similarityThreshold,
    );

    let relevantFilePaths = new Set<string>();

    for (const res of summaryResults) {
      if (res.nodeType === "file") {
        context.files.push(res.summary as FileSummary);
        relevantFilePaths.add(res.nodeKey);
      } else if (
        res.nodeType === "component" &&
        context.components.length < (options.maxComponents || 3)
      ) {
        context.components.push(res.summary as ComponentSummary);
        const childFiles = await semanticRetrievalService.resolveComponentFiles(
          repositoryId,
          res.nodeKey,
        );
        const fileLimit = options.maxFiles || 5;
        let added = 0;
        for (const cf of childFiles) {
          if (added >= fileLimit) break;
          if (!relevantFilePaths.has(cf.nodeKey)) {
            context.files.push(cf.summary as FileSummary);
            relevantFilePaths.add(cf.nodeKey);
            added++;
          }
        }
      }
    }

    context.components = context.components.slice(0, options.maxComponents);
    context.files = context.files.slice(0, options.maxFiles);

    if (relevantFilePaths.size === 0) {
      context.metadata.usedFallback = true;
      context.codeChunks = await semanticRetrievalService.searchCodeChunks(
        repositoryId,
        queryVectorStr,
        options,
      );
    } else {
      context.codeChunks = await semanticRetrievalService.searchCodeChunks(
        repositoryId,
        queryVectorStr,
        options,
        Array.from(relevantFilePaths),
      );
    }

    return context;
  }

  // --- Interview Mode (Legacy behavior preserved) ---
  public async retrieveInterviewStartContext(clerkUserId: string, repositoryId: string, opts?: RetrievalOptions): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSynced(clerkUserId, repositoryId);

    const context: RetrievedContext = {
      repository: null,
      architecture: null,
      components: [],
      files: [],
      codeChunks: [],
      metadata: {
        mode: "interview",
        usedFallback: false,
        query: "",
        retrievalStage: "start",
      },
    };

    const repoSummaries = await semanticRetrievalService.searchSummaries(repositoryId, "[0]", "repository", 1, 0);
    if (repoSummaries.length > 0) context.repository = repoSummaries[0].summary as any;

    const archSummaries = await semanticRetrievalService.searchSummaries(repositoryId, "[0]", "architecture", 1, 0);
    if (archSummaries.length > 0) context.architecture = archSummaries[0].summary as any;

    let componentKeys: string[] = [];
    if (context.architecture && context.architecture.majorComponents) {
      componentKeys = context.architecture.majorComponents;
    }

    if (componentKeys.length > 0) {
      const compSummaries = await semanticRetrievalService.getComponentSummaries(repositoryId, componentKeys.slice(0, options.maxComponents || 3));
      context.components = compSummaries.map(c => c.summary as ComponentSummary);
    } else {
      const compSummaries = await semanticRetrievalService.searchSummaries(repositoryId, "[0]", "component", options.maxComponents || 3, 0);
      context.components = compSummaries.map(c => c.summary as ComponentSummary);
      context.metadata.usedFallback = true;
    }

    return context;
  }

  public async retrieveInterviewFollowUpContext(clerkUserId: string, repositoryId: string, query: string, opts?: RetrievalOptions): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const queryVectorStr = await semanticRetrievalService.getQueryVectorStr(query);

    const context: RetrievedContext = {
      repository: null,
      architecture: null,
      components: [],
      files: [],
      codeChunks: [],
      metadata: {
        mode: "interview",
        usedFallback: false,
        query,
        retrievalStage: "follow_up",
      },
    };

    const components = await semanticRetrievalService.searchSummaries(repositoryId, queryVectorStr, "component", options.maxComponents, options.similarityThreshold);
    context.components = components.map((c) => c.summary as ComponentSummary);

    const componentKeys = components.map((c) => c.nodeKey);
    if (componentKeys.length > 0) {
       for (const key of componentKeys) {
         const files = await semanticRetrievalService.resolveComponentFiles(repositoryId, key);
         context.files.push(...files.slice(0, 2).map(f => f.summary as FileSummary));
       }
       context.files = context.files.slice(0, options.maxFiles);
    }

    if (options.includeCode) {
      const filePaths = context.files.map((f) => f.path || (f as any).filePath).filter(Boolean);
      context.codeChunks = await semanticRetrievalService.searchCodeChunks(repositoryId, queryVectorStr, options, filePaths.length > 0 ? filePaths : undefined);
    }

    return context;
  }

  // --- REVIEW MODE: Hybrid Retrieval Pipeline ---
  public async retrieveReviewContext(
    clerkUserId: string,
    repositoryId: string,
    query: string,
    changedFiles: string[],
    opts?: RetrievalOptions,
  ): Promise<RetrievedContext> {
    const startTime = performance.now();
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSynced(clerkUserId, repositoryId);

    const queryVectorStr = await semanticRetrievalService.getQueryVectorStr(query);
    const rawCandidates: RetrievalCandidate[] = [];

    const trace: RetrievalTrace = {
      timingMs: {
        changedAnalysis: 0,
        exactSymbol: 0,
        graphExpansion: 0,
        semanticRetrieval: 0,
        mergeAndRerank: 0,
        budgetAllocation: 0,
        total: 0
      },
      counts: {
        exactSymbol: 0,
        graphDependency: 0,
        graphDependent: 0,
        relatedTest: 0,
        semantic: 0,
        totalPreMerge: 0,
        totalPostMerge: 0,
        finalAccepted: 0
      },
      budget: {
        changedCodeTokens: 0,
        graphTokens: 0,
        testTokens: 0,
        semanticTokens: 0,
        totalTokens: 0
      },
      droppedCandidates: []
    };

    let t0 = performance.now();

    // Stage 1: Changed Code Analysis
    const changedSymbols = await changedSymbolAnalysisService.getSymbolsInChangedFiles(repositoryId, changedFiles);
    
    trace.timingMs.changedAnalysis = performance.now() - t0;
    t0 = performance.now();

    // Stage 2: Add exact symbols from changed files
    for (const sym of changedSymbols) {
      const defs = await symbolRetrievalService.getSymbolDefinition(repositoryId, sym.symbolName);
      for (const def of defs) {
        rawCandidates.push(this.chunkToCandidate(def, "exact_symbol"));
        trace.counts.exactSymbol++;
      }
    }
    
    trace.timingMs.exactSymbol = performance.now() - t0;
    t0 = performance.now();

    // Stage 3: Structural Expansion (Graph)
    for (const file of changedFiles) {
      // 3a. Direct dependencies
      const deps = await repositoryGraphService.getDirectDependencies(repositoryId, file);
      if (deps.length > 0) {
         const depSummaries = await semanticRetrievalService.getFileSummaries(repositoryId, deps);
         depSummaries.forEach(s => {
           rawCandidates.push(this.summaryToCandidate(s, "graph_dependency"));
           trace.counts.graphDependency++;
         });
      }

      // 3b. Direct dependents
      const dependents = await repositoryGraphService.getDirectDependents(repositoryId, file);
      if (dependents.length > 0) {
         const depSummaries = await semanticRetrievalService.getFileSummaries(repositoryId, dependents);
         depSummaries.forEach(s => {
           rawCandidates.push(this.summaryToCandidate(s, "graph_dependent"));
           trace.counts.graphDependent++;
         });
      }

      // 3c. Related Tests
      const tests = await relatedTestDiscoveryService.discoverTestsForFile(repositoryId, file);
      if (tests.length > 0) {
        const testSummaries = await semanticRetrievalService.getFileSummaries(repositoryId, tests);
        testSummaries.forEach(s => {
          rawCandidates.push(this.summaryToCandidate(s, "related_test"));
          trace.counts.relatedTest++;
        });
      }
    }

    let usedFallback = false;
    // Fallback: If no graph links were found, we are operating blindly. Record this.
    if (trace.counts.graphDependency === 0 && trace.counts.graphDependent === 0) {
      usedFallback = true;
    }

    trace.timingMs.graphExpansion = performance.now() - t0;
    t0 = performance.now();

    // Stage 4: Global Semantic Retrieval
    const semanticChunks = await semanticRetrievalService.searchCodeChunks(repositoryId, queryVectorStr, options);
    for (const chunk of semanticChunks) {
      rawCandidates.push(this.chunkToCandidate(chunk, "semantic_chunk"));
      trace.counts.semantic++;
    }

    const semanticSummaries = await semanticRetrievalService.searchSummaries(repositoryId, queryVectorStr, "file", 5, options.similarityThreshold);
    for (const summary of semanticSummaries) {
       rawCandidates.push(this.summaryToCandidate(summary, "semantic_summary"));
       trace.counts.semantic++;
    }

    trace.counts.totalPreMerge = rawCandidates.length;

    trace.timingMs.semanticRetrieval = performance.now() - t0;
    t0 = performance.now();

    // Stage 5: Merge & Deduplicate
    const mergeResult = candidateMergerService.mergeCandidates(rawCandidates);
    let candidates = mergeResult.candidates;
    trace.droppedCandidates.push(...mergeResult.dropped);
    trace.counts.totalPostMerge = candidates.length;

    // Stage 6: Rerank
    candidates = retrievalRerankerService.rerankCandidates(candidates);

    trace.timingMs.mergeAndRerank = performance.now() - t0;
    t0 = performance.now();

    // Stage 7: Context Budgeting
    const budgetResult = contextBudgetService.allocateBudget(candidates, options.maxTokens || 15000);
    const finalCandidates = budgetResult.accepted;
    
    trace.droppedCandidates.push(...budgetResult.dropped);
    trace.counts.finalAccepted = finalCandidates.length;
    trace.budget = budgetResult.budget;

    trace.timingMs.budgetAllocation = performance.now() - t0;
    trace.timingMs.total = performance.now() - startTime;

    // Finally: Format as RetrievedContext for consumer compatibility
    const context: RetrievedContext = {
      repository: null,
      architecture: null,
      components: [],
      files: [],
      codeChunks: [],
      metadata: { mode: "review", usedFallback, query, trace },
    };

    for (const c of finalCandidates) {
      if (c.dataType === "code_chunk") {
        context.codeChunks.push({
          filePath: c.metadata.filePath!,
          symbolName: c.metadata.symbolName!,
          symbolType: "unknown",
          content: c.content,
          lineStart: c.metadata.startLine!,
          lineEnd: c.metadata.endLine!,
          similarity: c.score
        });
      } else if (c.dataType === "file_summary") {
         try {
           context.files.push(JSON.parse(c.content) as FileSummary);
         } catch(e) {}
      }
    }

    // Also include changed file summaries explicitly 
    const changedFileSummaries = await semanticRetrievalService.getFileSummaries(repositoryId, changedFiles);
    for (const cf of changedFileSummaries) {
       context.files.push(cf.summary as FileSummary);
    }

    // Deduplicate files
    context.files = Array.from(new Map(context.files.map(f => [f.path, f])).values());

    return context;
  }

  private chunkToCandidate(chunk: CodeChunkSearchResult, sourceType: keyof typeof RETRIEVAL_WEIGHTS): RetrievalCandidate {
    return {
      identityKey: `${chunk.filePath}#${chunk.lineStart}-${chunk.lineEnd}`,
      content: chunk.content,
      dataType: "code_chunk",
      sources: [{ type: sourceType, weight: RETRIEVAL_WEIGHTS[sourceType] }],
      score: 0,
      metadata: {
        filePath: chunk.filePath,
        startLine: chunk.lineStart,
        endLine: chunk.lineEnd,
        symbolName: chunk.symbolName
      }
    };
  }

  private summaryToCandidate(summary: any, sourceType: keyof typeof RETRIEVAL_WEIGHTS): RetrievalCandidate {
    return {
      identityKey: summary.nodeKey,
      content: JSON.stringify(summary.summary),
      dataType: "file_summary",
      sources: [{ type: sourceType, weight: RETRIEVAL_WEIGHTS[sourceType] }],
      score: 0,
      metadata: {
        filePath: summary.nodeKey,
      }
    };
  }
}

export const retrievalService = new RepositoryRetrievalService();
