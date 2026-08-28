import { pool } from "../config/db.js";

export class RepositoryGraphService {
  /**
   * Retrieves files that the given file imports.
   */
  public async getDirectDependencies(repositoryId: string, filePath: string): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT target_node_key 
       FROM repository_relationships 
       WHERE repository_id = $1 
         AND source_node_type = 'file' 
         AND source_node_key = $2 
         AND relationship_type = 'IMPORTS'`,
      [repositoryId, filePath]
    );
    return rows.map((r) => r.target_node_key);
  }

  /**
   * Retrieves files that import the given file.
   */
  public async getDirectDependents(repositoryId: string, filePath: string): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT source_node_key 
       FROM repository_relationships 
       WHERE repository_id = $1 
         AND target_node_type = 'file' 
         AND target_node_key = $2 
         AND relationship_type = 'IMPORTS'`,
      [repositoryId, filePath]
    );
    return rows.map((r) => r.source_node_key);
  }

  /**
   * Retrieves all file paths belonging to a given component.
   */
  public async getFilesInComponent(repositoryId: string, componentName: string): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT node_key 
       FROM repository_summaries 
       WHERE repository_id = $1 
         AND node_type = 'file' 
         AND parent_key = $2`,
      [repositoryId, componentName]
    );
    return rows.map((r) => r.node_key);
  }

  /**
   * Retrieves the parent component for a given file.
   */
  public async getComponentForFile(repositoryId: string, filePath: string): Promise<string | null> {
    const { rows } = await pool.query(
      `SELECT parent_key 
       FROM repository_summaries 
       WHERE repository_id = $1 
         AND node_type = 'file' 
         AND node_key = $2
       LIMIT 1`,
      [repositoryId, filePath]
    );
    if (rows.length === 0) return null;
    return rows[0].parent_key;
  }
}

export const repositoryGraphService = new RepositoryGraphService();
