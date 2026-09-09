import { pool } from "../config/db.js";
import { withCache } from "../utils/cache.js";

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
   * Batched form of getDirectDependencies for many files at once — turns
   * review's per-changed-file expansion loop from N round trips into 1.
   */
  public async getDirectDependenciesForFiles(
    repositoryId: string,
    filePaths: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>(filePaths.map((p) => [p, []]));
    if (filePaths.length === 0) return result;

    const { rows } = await pool.query(
      `SELECT source_node_key, target_node_key
       FROM repository_relationships
       WHERE repository_id = $1
         AND source_node_type = 'file'
         AND source_node_key = ANY($2::text[])
         AND relationship_type = 'IMPORTS'`,
      [repositoryId, filePaths],
    );
    for (const r of rows) {
      result.get(r.source_node_key)!.push(r.target_node_key);
    }
    return result;
  }

  /**
   * Batched form of getDirectDependents for many files at once.
   */
  public async getDirectDependentsForFiles(
    repositoryId: string,
    filePaths: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>(filePaths.map((p) => [p, []]));
    if (filePaths.length === 0) return result;

    const { rows } = await pool.query(
      `SELECT target_node_key, source_node_key
       FROM repository_relationships
       WHERE repository_id = $1
         AND target_node_type = 'file'
         AND target_node_key = ANY($2::text[])
         AND relationship_type = 'IMPORTS'`,
      [repositoryId, filePaths],
    );
    for (const r of rows) {
      result.get(r.target_node_key)!.push(r.source_node_key);
    }
    return result;
  }

  /**
   * Import fan-in (count of distinct importers) for every file that has at
   * least one, repository-wide — a structural proxy for "architecturally
   * central", available at SEARCHABLE (Phase 1) with no LLM summary
   * required. Underlies Interview's module inventory (see
   * RepositoryRetrievalService#buildModuleInventory), which sums this per
   * module to rank the areas offered for orientation/NEW_TOPIC.
   */
  public async getImportFanInCounts(repositoryId: string): Promise<Map<string, number>> {
    // Cached as entry pairs, not a Map — JSON.stringify silently turns a
    // Map into "{}", so withCache's serialization needs a plain array here.
    const entries = await withCache<[string, number][]>(
      `repo:${repositoryId}:import-fan-in`,
      600,
      async () => {
        const { rows } = await pool.query(
          `SELECT target_node_key, COUNT(*)::int AS fan_in
           FROM repository_relationships
           WHERE repository_id = $1
             AND target_node_type = 'file'
             AND relationship_type = 'IMPORTS'
           GROUP BY target_node_key`,
          [repositoryId],
        );
        return rows.map((r) => [r.target_node_key as string, r.fan_in as number]);
      },
    );
    return new Map(entries);
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
