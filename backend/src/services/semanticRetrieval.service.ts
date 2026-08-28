import { pool } from "../config/db.js";
import { embedder } from "./embedding.service.js";
import type { CodeChunkSearchResult, RetrievalOptions, SummarySearchResult } from "../types/retrievalTypes.js";

const DEFAULT_OPTIONS: RetrievalOptions = {
  maxComponents: 3,
  maxFiles: 5,
  maxCodeChunks: 10,
  similarityThreshold: 0.6,
};

export class SemanticRetrievalService {
  /**
   * Generates a single query embedding to be reused across searches.
   */
  public async getQueryVectorStr(queryText: string): Promise<string> {
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
   * Search code chunks, optionally restricted to specific file paths.
   */
  public async searchCodeChunks(
    repositoryId: string,
    queryVectorStr: string,
    options: RetrievalOptions,
    restrictedFilePaths?: string[],
  ): Promise<CodeChunkSearchResult[]> {
    const limit = options.maxCodeChunks || DEFAULT_OPTIONS.maxCodeChunks;
    const threshold = options.similarityThreshold || DEFAULT_OPTIONS.similarityThreshold;

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
        `SELECT node_type, node_key, parent_key, summary_json
         FROM repository_summaries
         WHERE repository_id = $1 AND node_type = 'file' AND node_key = ANY($2)`,
        [repositoryId, filePaths],
      );

      return rows.map((r) => ({
        nodeType: r.node_type,
        nodeKey: r.node_key,
        parentKey: r.parent_key,
        summary: r.summary_json,
        similarity: 1.0, 
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
        `SELECT node_type, node_key, parent_key, summary_json
         FROM repository_summaries
         WHERE repository_id = $1 AND node_type = 'component' AND node_key = ANY($2)`,
        [repositoryId, componentNames],
      );

      return rows.map((r) => ({
        nodeType: r.node_type,
        nodeKey: r.node_key,
        parentKey: r.parent_key,
        summary: r.summary_json,
        similarity: 1.0,
      }));
    } finally {
      client.release();
    }
  }

  public async resolveComponentFiles(
    repositoryId: string,
    componentName: string,
  ): Promise<SummarySearchResult[]> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT node_type, node_key, parent_key, summary_json
         FROM repository_summaries
         WHERE repository_id = $1 AND node_type = 'file' AND parent_key = $2`,
        [repositoryId, componentName],
      );

      return rows.map((r) => ({
        nodeType: r.node_type,
        nodeKey: r.node_key,
        parentKey: r.parent_key,
        summary: r.summary_json,
        similarity: 1.0, 
      }));
    } finally {
      client.release();
    }
  }
}

export const semanticRetrievalService = new SemanticRetrievalService();
