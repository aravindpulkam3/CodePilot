import type { PoolClient } from "pg";
import type { IRelationshipIndexer } from "../../shared/utils/transactionBuffer.js";

export interface RelationshipMetadata {
  source: "ast" | "llm_summary";
  [key: string]: unknown;
}

export class RelationshipIndexingService implements IRelationshipIndexer {
  constructor(private db: PoolClient) {}

  /**
   * Replaces all structural relationships for a given file in a single transaction.
   * This includes outgoing IMPORTS edges.
   */
  public async indexFileRelationships(
    repositoryId: string,
    filePath: string,
    imports: { resolvedPath: string; specifier: string }[]
  ): Promise<void> {
    // 1. Delete old IMPORTS for this file
    await this.db.query(
      `DELETE FROM repository_relationships 
       WHERE repository_id = $1 
         AND source_node_type = 'file' 
         AND source_node_key = $2 
         AND relationship_type = 'IMPORTS'`,
      [repositoryId, filePath]
    );

    // 2. Insert new IMPORTS
    if (imports.length > 0) {
      // Build batch insert query to minimize round-trips
      const values: string[] = [];
      const queryParams: any[] = [];
      
      let paramIndex = 1;
      
      for (const imp of imports) {
        const metadata: RelationshipMetadata = {
          source: "ast",
          specifier: imp.specifier
        };

        values.push(`($${paramIndex++}, 'file', $${paramIndex++}, 'file', $${paramIndex++}, 'IMPORTS', $${paramIndex++}::jsonb)`);
        queryParams.push(
          repositoryId,
          filePath,
          imp.resolvedPath,
          JSON.stringify(metadata)
        );
      }

      await this.db.query(
        `INSERT INTO repository_relationships (repository_id, source_node_type, source_node_key, target_node_type, target_node_key, relationship_type, metadata)
         VALUES ${values.join(", ")}
         ON CONFLICT (repository_id, source_node_type, source_node_key, target_node_type, target_node_key, relationship_type) 
         DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()`,
        queryParams
      );
    }
  }

  /**
   * Moves a file's relationships from its old path to its new one.
   *
   * NOT the same as delete-then-reindex. The renamed file's OUTGOING edges are
   * dropped (the caller re-indexes them from the new content in this same
   * transaction), but INCOMING edges are RETARGETED rather than deleted:
   * an importer only appears in a sync's changed-file set if its own bytes
   * changed, and several real renames don't require that — a case-only rename,
   * an extension-only rename (foo.js -> foo.ts, which resolves either way),
   * or file -> directory-index (src/auth.ts -> src/auth/index.ts). Deleting
   * those edges would drop real relationships that nothing rebuilds until the
   * importer is next edited.
   */
  public async renameFileRelationships(
    repositoryId: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    // 1. Outgoing edges of the renamed file — rebuilt from its new content.
    await this.db.query(
      `DELETE FROM repository_relationships
       WHERE repository_id = $1
         AND source_node_type = 'file'
         AND source_node_key = $2`,
      [repositoryId, oldPath]
    );

    // 2. Incoming edges -> point them at the new path. The NOT EXISTS guard
    // covers the case where the importer ALREADY has an edge to newPath (a
    // rename that overwrites a file the importer also imported): without it
    // this UPDATE would violate the table's UNIQUE constraint.
    await this.db.query(
      `UPDATE repository_relationships r
          SET target_node_key = $3, updated_at = NOW()
        WHERE r.repository_id = $1
          AND r.target_node_type = 'file'
          AND r.target_node_key = $2
          AND NOT EXISTS (
            SELECT 1 FROM repository_relationships e
             WHERE e.repository_id = r.repository_id
               AND e.source_node_type = r.source_node_type
               AND e.source_node_key = r.source_node_key
               AND e.target_node_type = 'file'
               AND e.target_node_key = $3
               AND e.relationship_type = r.relationship_type
          )`,
      [repositoryId, oldPath, newPath]
    );

    // 3. Whatever step 2 deliberately skipped is now redundant (an equivalent
    // edge to newPath already exists), so drop it.
    await this.db.query(
      `DELETE FROM repository_relationships
       WHERE repository_id = $1
         AND target_node_type = 'file'
         AND target_node_key = $2`,
      [repositoryId, oldPath]
    );
  }

  /**
   * Clears all relationships where this file is either the source or target.
   * Useful when a file is deleted.
   */
  public async deleteFileRelationships(repositoryId: string, filePath: string): Promise<void> {
    await this.db.query(
      `DELETE FROM repository_relationships
       WHERE repository_id = $1 
         AND (
           (source_node_type = 'file' AND source_node_key = $2)
           OR
           (target_node_type = 'file' AND target_node_key = $2)
         )`,
      [repositoryId, filePath]
    );
  }
}
