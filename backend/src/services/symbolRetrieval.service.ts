import { pool } from "../config/db.js";
import type { CodeChunkSearchResult } from "../types/retrievalTypes.js";

export class SymbolRetrievalService {
  /**
   * Looks up the definition of a specific symbol in the repository.
   * Uses exact match on symbol_name.
   */
  public async getSymbolDefinition(repositoryId: string, symbolName: string): Promise<CodeChunkSearchResult[]> {
    const { rows } = await pool.query(
      `SELECT file_path, symbol_name, symbol_type, content, start_line, end_line 
       FROM repository_embeddings 
       WHERE repository_id = $1 AND symbol_name = $2`,
      [repositoryId, symbolName]
    );

    return rows.map((r) => ({
      filePath: r.file_path,
      symbolName: r.symbol_name,
      symbolType: r.symbol_type,
      content: r.content,
      lineStart: r.start_line,
      lineEnd: r.end_line,
      similarity: 1.0, // Exact match
    }));
  }
}

export const symbolRetrievalService = new SymbolRetrievalService();
