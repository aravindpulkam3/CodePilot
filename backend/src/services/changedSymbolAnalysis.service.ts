import { pool } from "../config/db.js";

export interface ChangedSymbol {
  filePath: string;
  symbolName: string;
  symbolType: string;
}

export class ChangedSymbolAnalysisService {
  /**
   * Retrieves all symbols defined in the given changed files.
   * In the future, this can be refined to intersect with Git diff line ranges
   * to return ONLY the symbols that were actually modified.
   */
  public async getSymbolsInChangedFiles(repositoryId: string, changedFilePaths: string[]): Promise<ChangedSymbol[]> {
    if (!changedFilePaths || changedFilePaths.length === 0) return [];

    const { rows } = await pool.query(
      `SELECT file_path, symbol_name, symbol_type 
       FROM repository_embeddings 
       WHERE repository_id = $1 AND file_path = ANY($2)`,
      [repositoryId, changedFilePaths]
    );

    return rows.map((r) => ({
      filePath: r.file_path,
      symbolName: r.symbol_name,
      symbolType: r.symbol_type
    }));
  }
}

export const changedSymbolAnalysisService = new ChangedSymbolAnalysisService();
