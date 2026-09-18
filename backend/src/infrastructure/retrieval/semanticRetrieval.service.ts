import { pool } from "../../config/db.js";
import { embedder } from "../embedding/embedding.service.js";
import { withCache } from "../../shared/utils/cache.js";
import type { CodeChunkSearchResult, DocChunkSearchResult, RetrievalOptions } from "./retrievalTypes.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { docRetrievalLog, isReadmeDebugEnabled } from "../../shared/utils/readmeDebugLog.js";

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
   * Search DOCUMENTATION rows: README/ARCHITECTURE/CONTRIBUTING sections and
   * whole-file manifest/config rows (see utils/documentationPaths.ts).
   *
   * Deliberately NOT restricted by file path, unlike searchCodeChunksInFiles:
   * which documentation answers a question is decided by similarity alone.
   *
   * Threshold is an explicit parameter rather than read from the shared
   * constant, so documentation can be retuned independently later without
   * touching code retrieval. See RetrievalOptions.docSimilarityThreshold.
   */
  public async searchDocumentationChunks(
    repositoryId: string,
    queryVectorStr: string,
    limit: number = 3,
    threshold: number = DEFAULT_OPTIONS.similarityThreshold!,
  ): Promise<DocChunkSearchResult[]> {
    const client = await pool.connect();
    try {
      const query = `
        SELECT
          file_path,
          symbol_type,
          symbol_name,
          start_line,
          end_line,
          content,
          commit_sha,
          1 - (embedding <=> $1::vector) AS similarity_score
        FROM repository_embeddings
        WHERE repository_id = $2
          AND symbol_type = 'documentation'
          AND (1 - (embedding <=> $1::vector)) >= $3
        ORDER BY embedding <=> $1::vector
        LIMIT $4
      `;

      const { rows } = await client.query(query, [queryVectorStr, repositoryId, threshold, limit]);

      // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
      // When nothing comes back, distinguish "this repo has no documentation
      // indexed at all" from "it has some, but nothing cleared the
      // threshold" — those need completely different fixes.
      if (isReadmeDebugEnabled && rows.length === 0) {
        const { rows: diag } = await client.query(
          `SELECT count(*)::int AS total FROM repository_embeddings
           WHERE repository_id = $1 AND symbol_type = 'documentation'`,
          [repositoryId],
        );
        const total = diag[0]?.total ?? 0;
        docRetrievalLog(
          total === 0
            ? `0 results — repo ${repositoryId} has NO documentation rows indexed at all. ` +
                `The README was never chunked (re-sync needed), not a threshold problem.`
            : `0 results — repo ${repositoryId} has ${total} documentation row(s) indexed, ` +
                `but none scored >= ${threshold}. This is a threshold/relevance outcome, not missing data.`,
        );
      } else {
        docRetrievalLog(
          `${rows.length} documentation section(s) above threshold ${threshold} (limit ${limit}) for repo ${repositoryId}.`,
        );
      }

      return rows.map((r) => ({
        filePath: r.file_path,
        symbolType: r.symbol_type,
        symbolName: r.symbol_name,
        sectionPath: r.symbol_name,
        lineStart: r.start_line,
        lineEnd: r.end_line,
        content: r.content,
        similarity: r.similarity_score,
        commitSha: r.commit_sha ?? undefined,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves the top-k code chunks WITHIN a specific set of files.
   *
   * This is the primitive that makes structural (graph/test/changed-file)
   * retrieval useful for PR review. The graph tells you WHICH files matter;
   * this fetches their actual CODE.
   *
   * THRESHOLD DEFAULTS TO 0, DELIBERATELY. The whole point of graph expansion
   * is "show me the caller whether or not it happens to embed near the PR
   * title". Applying the shared 0.6 floor here would recreate the exact
   * emptiness this replaced, just via a different mechanism. Structural
   * recall is bounded by COUNT and TOKEN BUDGET, never by a similarity floor.
   * The 0.6 floor still applies to the global semantic stage, where it belongs.
   *
   * Uses ROW_NUMBER() so each file gets its own top-k rather than one
   * chunk-dense file consuming the entire global limit.
   */
  public async searchCodeChunksInFiles(
    repositoryId: string,
    queryVectorStr: string,
    filePaths: string[],
    perFileLimit: number = 3,
    totalLimit: number = 30,
    threshold: number = 0,
  ): Promise<CodeChunkSearchResult[]> {
    if (!filePaths || filePaths.length === 0) return [];

    const client = await pool.connect();
    try {
      // Documentation is excluded for the same reason searchCodeChunks
      // excludes it: a README-editing PR would otherwise get its README in
      // <RepositoryContext> as "code", in <Documentation>, AND in the diff.
      const query = `
        SELECT file_path, symbol_type, symbol_name, start_line, end_line, content, commit_sha, similarity_score
        FROM (
          SELECT
            file_path,
            symbol_type,
            symbol_name,
            start_line,
            end_line,
            content,
            commit_sha,
            1 - (embedding <=> $1::vector) AS similarity_score,
            ROW_NUMBER() OVER (
              PARTITION BY file_path
              ORDER BY embedding <=> $1::vector
            ) AS rn
          FROM repository_embeddings
          WHERE repository_id = $2
            AND symbol_type <> 'documentation'
            AND file_path = ANY($3)
            AND (1 - (embedding <=> $1::vector)) >= $4
        ) ranked
        WHERE rn <= $5
        ORDER BY similarity_score DESC
        LIMIT $6
      `;

      const { rows } = await client.query(query, [
        queryVectorStr,
        repositoryId,
        filePaths,
        threshold,
        perFileLimit,
        totalLimit,
      ]);

      return rows.map((r) => ({
        filePath: r.file_path,
        symbolType: r.symbol_type,
        symbolName: r.symbol_name,
        lineStart: r.start_line,
        lineEnd: r.end_line,
        content: r.content,
        similarity: r.similarity_score,
        commitSha: r.commit_sha ?? undefined,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Search code chunks, optionally restricted to (or excluding) file paths.
   *
   * Excludes documentation rows so the code and documentation searches stay
   * disjoint — otherwise a README section could be returned by both and
   * double-counted in the prompt, and would arrive unlabelled as code.
   */
  public async searchCodeChunks(
    repositoryId: string,
    queryVectorStr: string,
    options: RetrievalOptions,
    restrictedFilePaths?: string[],
    excludedFilePaths?: string[],
  ): Promise<CodeChunkSearchResult[]> {
    // ?? not ||: an explicit 0 (threshold 0, or a 0 limit) must be honoured.
    const limit = options.maxCodeChunks ?? DEFAULT_OPTIONS.maxCodeChunks;
    const threshold = options.similarityThreshold ?? DEFAULT_OPTIONS.similarityThreshold;

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
          commit_sha,
          1 - (embedding <=> $1::vector) AS similarity_score
        FROM repository_embeddings
        WHERE repository_id = $2
          AND symbol_type <> 'documentation'
          AND (1 - (embedding <=> $1::vector)) >= $3
      `;
      const params: any[] = [queryVectorStr, repositoryId, threshold];

      if (restrictedFilePaths && restrictedFilePaths.length > 0) {
        params.push(restrictedFilePaths);
        query += ` AND file_path = ANY($${params.length})`;
      }

      // Used by review's global-semantic stage to skip files already covered
      // by a structural class, so the same chunk can't arrive twice under two
      // different source types.
      if (excludedFilePaths && excludedFilePaths.length > 0) {
        params.push(excludedFilePaths);
        query += ` AND file_path <> ALL($${params.length})`;
      }

      params.push(limit);
      query += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length}`;

      const { rows } = await client.query(query, params);

      return rows.map((r) => ({
        filePath: r.file_path,
        symbolType: r.symbol_type,
        symbolName: r.symbol_name,
        lineStart: r.start_line,
        lineEnd: r.end_line,
        content: r.content,
        similarity: r.similarity_score,
        commitSha: r.commit_sha ?? undefined,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Every distinct file path with at least one indexed CODE chunk (excludes
   * documentation rows). The module inventory's source (repositoryMap.service.ts)
   * and the nextFocus validation ladder (exact-match and unique-basename
   * resolution) in interview.service.ts#resolveFocus.
   */
  public async listIndexedFilePaths(repositoryId: string): Promise<string[]> {
    return withCache(`repo:${repositoryId}:indexed-paths`, 600, async () => {
      const { rows } = await pool.query(
        `SELECT DISTINCT file_path FROM repository_embeddings
         WHERE repository_id = $1 AND symbol_type <> 'documentation'`,
        [repositoryId],
      );
      return rows.map((r) => r.file_path);
    });
  }
}

export const semanticRetrievalService = new SemanticRetrievalService();
