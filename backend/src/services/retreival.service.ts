import { pool } from "../config/db.js";
import { embedder } from "./embedding.service.js";
import { repositorySyncService } from "./repositorySync.service.js";
import {
  CodeChunkSearchResult,
  RetrievalOptions,
  RetrievedContext,
  SummarySearchResult,
} from "../types/retrievalTypes.js";
import {
  ArchitectureSummary,
  ComponentSummary,
  FileSummary,
  RepositorySummary,
} from "../types/summaryTypes.js";

const DEFAULT_OPTIONS: RetrievalOptions = {
  maxComponents: 3,
  maxFiles: 5,
  maxCodeChunks: 10,
  similarityThreshold: 0.6,
};

export class RepositoryRetrievalService {
  /**
   * Generates a single query embedding to be reused across searches.
   */
  private async getQueryVectorStr(queryText: string): Promise<string> {
    const queryVector = await embedder.embedQuery(queryText);
    return `[${queryVector.join(",")}]`;
  }

  /**
   * Search summaries using pgvector.
   */
  public async searchSummaries(
    repositoryId: string,
    queryVectorStr: string,
    nodeType?: "repository" | "architecture" | "component" | "file",
    limit: number = 5,
    threshold: number = 0.6,
  ): Promise<SummarySearchResult[]> {
    const client = await pool.connect();
    try {
      let query = `
        SELECT 
          node_type, 
          node_key, 
          parent_key, 
          summary_json,
          1 - (embedding <=> $1::vector) AS similarity
        FROM repository_summaries
        WHERE repository_id = $2
          AND (1 - (embedding <=> $1::vector)) >= $3
      `;
      const params: any[] = [queryVectorStr, repositoryId, threshold];

      if (nodeType) {
        query += ` AND node_type = $4`;
        params.push(nodeType);
      }

      query += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
      params.push(limit);

      const { rows } = await client.query(query, params);

      return rows.map((r) => ({
        nodeType: r.node_type,
        nodeKey: r.node_key,
        parentKey: r.parent_key,
        summary: r.summary_json,
        similarity: r.similarity,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Fetches file summaries for a given component.
   */
  public async resolveComponentFiles(
    repositoryId: string,
    componentName: string,
  ): Promise<SummarySearchResult[]> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT 
          node_type, 
          node_key, 
          parent_key, 
          summary_json
         FROM repository_summaries
         WHERE repository_id = $1 AND node_type = 'file' AND parent_key = $2`,
        [repositoryId, componentName],
      );

      return rows.map((r) => ({
        nodeType: r.node_type,
        nodeKey: r.node_key,
        parentKey: r.parent_key,
        summary: r.summary_json,
        similarity: 1.0, // Exact match
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Direct fetch of specific file summaries
   */
  public async getFileSummaries(
    repositoryId: string,
    filePaths: string[],
  ): Promise<SummarySearchResult[]> {
    if (!filePaths.length) return [];

    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT 
          node_type, 
          node_key, 
          parent_key, 
          summary_json
         FROM repository_summaries
         WHERE repository_id = $1 AND node_type = 'file' AND node_key = ANY($2)`,
        [repositoryId, filePaths],
      );

      return rows.map((r) => ({
        nodeType: r.node_type,
        nodeKey: r.node_key,
        parentKey: r.parent_key,
        summary: r.summary_json,
        similarity: 1.0, // Exact match
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Fetches specific component summaries by name
   */
  public async getComponentSummaries(
    repositoryId: string,
    componentNames: string[],
  ): Promise<SummarySearchResult[]> {
    if (!componentNames.length) return [];

    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT 
          node_type, 
          node_key, 
          parent_key, 
          summary_json
         FROM repository_summaries
         WHERE repository_id = $1 AND node_type = 'component' AND node_key = ANY($2)`,
        [repositoryId, componentNames],
      );

      return rows.map((r) => ({
        nodeType: r.node_type,
        nodeKey: r.node_key,
        parentKey: r.parent_key,
        summary: r.summary_json,
        similarity: 1.0, // Exact match
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Search code chunks, optionally restricted to specific file paths.
   */
  public async searchCodeChunks(
    repositoryId: string,
    queryVectorStr: string,
    options: RetrievalOptions,
    restrictedFilePaths?: string[],
  ): Promise<CodeChunkSearchResult[]> {
    const limit = options.maxCodeChunks || DEFAULT_OPTIONS.maxCodeChunks;
    const threshold =
      options.similarityThreshold || DEFAULT_OPTIONS.similarityThreshold;

    const client = await pool.connect();
    try {
      let query = `
        SELECT 
          file_path, 
          symbol_type, 
          symbol_name, 
          start_line, 
          end_line, 
          content,
          1 - (embedding <=> $1::vector) AS similarity_score
        FROM repository_embeddings
        WHERE repository_id = $2
          AND (1 - (embedding <=> $1::vector)) >= $3
      `;
      const params: any[] = [queryVectorStr, repositoryId, threshold];

      if (restrictedFilePaths && restrictedFilePaths.length > 0) {
        query += ` AND file_path = ANY($4)`;
        params.push(restrictedFilePaths);
      }

      query += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
      params.push(limit);

      const { rows } = await client.query(query, params);

      return rows.map((r) => ({
        filePath: r.file_path,
        symbolType: r.symbol_type,
        symbolName: r.symbol_name,
        lineStart: r.start_line,
        lineEnd: r.end_line,
        content: r.content,
        similarity: r.similarity_score,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Performs JIT sync to ensure repo is up to date before retrieval.
   */
  private async ensureSynced(clerkUserId: string, repositoryId: string) {
    console.log(
      `[RetrievalService] JIT Sync check for repository ${repositoryId}...`,
    );
    await repositorySyncService.syncRepository(clerkUserId, repositoryId);
    console.log(
      `[RetrievalService] Repository is guaranteed up to date. Proceeding...`,
    );
  }

  /**
   * Q&A Retrieval Mode:
   * 1. Search summaries for relevant components/files.
   * 2. Search code chunks restricted to those files.
   * 3. Fallback to direct code chunk search if summaries are weak.
   */
  public async retrieveQAContext(
    clerkUserId: string,
    repositoryId: string,
    query: string,
    opts?: RetrievalOptions,
  ): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSynced(clerkUserId, repositoryId);

    const queryVectorStr = await this.getQueryVectorStr(query);
    const context: RetrievedContext = {
      repository: null,
      architecture: null,
      components: [],
      files: [],
      codeChunks: [],
      metadata: {
        mode: "qa",
        usedFallback: false,
        query,
      },
    };

    // 1. Semantic search over components and files
    const summaryResults = await this.searchSummaries(
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
        const childFiles = await this.resolveComponentFiles(
          repositoryId,
          res.nodeKey,
        );
        // Only include top N files from this component
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

    // Deduplicate component summaries and limit
    context.components = context.components.slice(0, options.maxComponents);
    context.files = context.files.slice(0, options.maxFiles);

    // 2. Fallback check
    if (relevantFilePaths.size === 0) {
      context.metadata.usedFallback = true;
      // Direct code chunk search without file restrictions
      context.codeChunks = await this.searchCodeChunks(
        repositoryId,
        queryVectorStr,
        options,
      );
    } else {
      // 3. Restricted code chunk search
      context.codeChunks = await this.searchCodeChunks(
        repositoryId,
        queryVectorStr,
        options,
        Array.from(relevantFilePaths),
      );
    }

    return context;
  }

  /**
   * Interview Retrieval Mode:
   * Prefer architecture/component summaries.
   * Only fetch code chunks if explicitly targeting implementation details.
   */
  public async retrieveInterviewContext(
    clerkUserId: string,
    repositoryId: string,
    query: string,
    opts?: RetrievalOptions,
  ): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSynced(clerkUserId, repositoryId);

    const queryVectorStr = await this.getQueryVectorStr(query);
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
      },
    };

    // Always fetch Repo and Architecture summaries for interview mode initially
    const topLevel = await this.searchSummaries(
      repositoryId,
      queryVectorStr,
      undefined,
      2,
      0.0,
    );
    const repoRes = topLevel.find((r) => r.nodeType === "repository");
    const archRes = topLevel.find((r) => r.nodeType === "architecture");
    if (repoRes) context.repository = repoRes.summary as RepositorySummary;
    if (archRes) context.architecture = archRes.summary as ArchitectureSummary;

    // Get relevant components
    const components = await this.searchSummaries(
      repositoryId,
      queryVectorStr,
      "component",
      options.maxComponents,
      options.similarityThreshold,
    );
    context.components = components.map((c) => c.summary as ComponentSummary);

    // If we have components, only fetch code chunks if they ask for implementation details
    const interviewOpts = { ...options, maxCodeChunks: 3 };
    const relevantFiles = await this.searchSummaries(
      repositoryId,
      queryVectorStr,
      "file",
      options.maxFiles,
      options.similarityThreshold,
    );
    context.files = relevantFiles.map((f) => f.summary as FileSummary);

    const filePaths = context.files.map(
      (f) => (f as any).filePath || (f as any).path,
    );

    context.codeChunks = await this.searchCodeChunks(
      repositoryId,
      queryVectorStr,
      interviewOpts,
      filePaths.length > 0 ? filePaths : undefined,
    );

    return context;
  }

  /**
   * Code Review Retrieval Mode:
   * Start from changed files -> fetch their summaries & parent components -> fetch related chunks.
   */
  public async retrieveReviewContext(
    clerkUserId: string,
    repositoryId: string,
    query: string,
    changedFiles: string[],
    opts?: RetrievalOptions,
  ): Promise<RetrievedContext> {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    await this.ensureSynced(clerkUserId, repositoryId);

    const queryVectorStr = await this.getQueryVectorStr(query);
    const context: RetrievedContext = {
      repository: null,
      architecture: null,
      components: [],
      files: [],
      codeChunks: [],
      metadata: {
        mode: "review",
        usedFallback: false,
        query,
      },
    };

    // 1. Get summaries for changed files
    const fileResults = await this.getFileSummaries(repositoryId, changedFiles);
    context.files = fileResults.map((r) => r.summary as FileSummary);

    // 2. Identify parent components
    const componentNames = new Set<string>();
    for (const res of fileResults) {
      if (res.parentKey) {
        componentNames.add(res.parentKey);
      }
    }

    // 3. Fetch parent component summaries
    if (componentNames.size > 0) {
      const compResults = await this.getComponentSummaries(
        repositoryId,
        Array.from(componentNames),
      );
      context.components = compResults.map(
        (r) => r.summary as ComponentSummary,
      );
    }

    // 4. Code search restricted primarily to the changed files
    context.codeChunks = await this.searchCodeChunks(
      repositoryId,
      queryVectorStr,
      options,
      changedFiles,
    );

    return context;
  }
}

export const retrievalService = new RepositoryRetrievalService();
