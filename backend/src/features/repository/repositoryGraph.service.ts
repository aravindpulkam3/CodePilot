import { pool } from "../../config/db.js";
import { withCache } from "../../shared/utils/cache.js";

/**
 * INVARIANT: every query here that returns import targets as file paths must
 * filter `resolved`. repository_imports also holds unresolved rows whose
 * target is an import SPECIFIER (e.g. "./repositorySync.service"), not a
 * path — see RelationshipIndexingService#resolvePendingImports. Without the
 * filter, a specifier would surface to Q&A, Review and Interview as a fake file.
 */
export class RepositoryGraphService {
  /**
   * Retrieves files that the given file imports.
   */
  public async getDirectDependencies(repositoryId: string, filePath: string): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT target
       FROM repository_imports
       WHERE repository_id = $1
         AND source_path = $2
         AND resolved`,
      [repositoryId, filePath]
    );
    return rows.map((r) => r.target);
  }

  /**
   * Retrieves files that import the given file.
   */
  public async getDirectDependents(repositoryId: string, filePath: string): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT source_path
       FROM repository_imports
       WHERE repository_id = $1
         AND target = $2
         AND resolved`,
      [repositoryId, filePath]
    );
    return rows.map((r) => r.source_path);
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
      `SELECT source_path, target
       FROM repository_imports
       WHERE repository_id = $1
         AND source_path = ANY($2::text[])
         AND resolved`,
      [repositoryId, filePaths],
    );
    for (const r of rows) {
      result.get(r.source_path)!.push(r.target);
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
      `SELECT target, source_path
       FROM repository_imports
       WHERE repository_id = $1
         AND target = ANY($2::text[])
         AND resolved`,
      [repositoryId, filePaths],
    );
    for (const r of rows) {
      result.get(r.target)!.push(r.source_path);
    }
    return result;
  }

  /**
   * Import fan-in (count of distinct importers) for every file that has at
   * least one, repository-wide — a structural proxy for "architecturally
   * central", available as soon as indexing completes, with no LLM. Underlies
   * Interview's module inventory (see
   * RepositoryMapService#buildModuleInventory), which sums this per
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
          `SELECT target, COUNT(*)::int AS fan_in
           FROM repository_imports
           WHERE repository_id = $1
             AND resolved
           GROUP BY target`,
          [repositoryId],
        );
        return rows.map((r) => [r.target as string, r.fan_in as number]);
      },
    );
    return new Map(entries);
  }
}

export const repositoryGraphService = new RepositoryGraphService();
