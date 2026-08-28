import type { PoolClient } from "pg";
import type { IRelationshipIndexer } from "../utils/transactionBuffer.js";

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
