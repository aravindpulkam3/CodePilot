import type { PoolClient } from "pg";
import type { IRelationshipIndexer } from "../../shared/utils/transactionBuffer.js";
import { resolveLocalImport, type LocalImport } from "../../shared/utils/importResolver.js";

export interface RelationshipMetadata {
  source: "ast";
  [key: string]: unknown;
}

interface EdgeRow {
  source: string;
  /** 'file' for a resolved edge, 'pending' for an unresolved relative specifier. */
  targetType: "file" | "pending";
  targetKey: string;
  specifier: string;
}

/** Rows per multi-VALUES insert — keeps the statement far below Postgres' 65535 bind-parameter limit. */
const INSERT_BATCH_SIZE = 500;

export class RelationshipIndexingService implements IRelationshipIndexer {
  constructor(private db: PoolClient) {}

  private async insertEdges(repositoryId: string, rows: EdgeRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
      const values: string[] = [];
      const params: any[] = [];
      let p = 1;
      for (const row of batch) {
        const metadata: RelationshipMetadata = { source: "ast", specifier: row.specifier };
        values.push(`($${p++}, 'file', $${p++}, $${p++}, $${p++}, 'IMPORTS', $${p++}::jsonb)`);
        params.push(repositoryId, row.source, row.targetType, row.targetKey, JSON.stringify(metadata));
      }
      await this.db.query(
        `INSERT INTO repository_relationships (repository_id, source_node_type, source_node_key, target_node_type, target_node_key, relationship_type, metadata)
         VALUES ${values.join(", ")}
         ON CONFLICT (repository_id, source_node_type, source_node_key, target_node_type, target_node_key, relationship_type)
         DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()`,
        params,
      );
    }
  }

  /**
   * Replaces all structural relationships for a given file in a single transaction.
   * This includes outgoing IMPORTS edges, and pending rows for relative
   * imports that could not be resolved yet (target_node_type = 'pending').
   */
  public async indexFileRelationships(
    repositoryId: string,
    filePath: string,
    imports: LocalImport[]
  ): Promise<void> {
    // 1. Delete old IMPORTS for this file. Deliberately no target_node_type
    // filter: re-indexing a file must also clear its stale pending rows.
    await this.db.query(
      `DELETE FROM repository_relationships
       WHERE repository_id = $1
         AND source_node_type = 'file'
         AND source_node_key = $2
         AND relationship_type = 'IMPORTS'`,
      [repositoryId, filePath]
    );

    // 2. Insert resolved edges and pending specifiers in one batch.
    if (imports.length > 0) {
      await this.insertEdges(
        repositoryId,
        imports.map((imp): EdgeRow =>
          imp.resolvedPath
            ? { source: filePath, targetType: "file", targetKey: imp.resolvedPath, specifier: imp.specifier }
            : { source: filePath, targetType: "pending", targetKey: imp.specifier, specifier: imp.specifier },
        ),
      );
    }
  }

  /**
   * Re-resolves every pending relative import for the repository against
   * its now-complete file list. Called from the finalize transaction once
   * every index chunk of a sync has committed, so edges lost because their
   * target sat in a later 50-file chunk are recovered. Resolved pending rows
   * become 'file' edges; the rest stay pending (a genuinely missing file, or
   * a specifier shape resolveLocalImport doesn't handle) and are retried on
   * the next sync's finalize.
   */
  public async resolvePendingImports(repositoryId: string): Promise<{ pending: number; resolved: number }> {
    const { rows: pendingRows } = await this.db.query(
      `SELECT source_node_key, target_node_key FROM repository_relationships
       WHERE repository_id = $1
         AND source_node_type = 'file'
         AND target_node_type = 'pending'
         AND relationship_type = 'IMPORTS'`,
      [repositoryId],
    );
    if (pendingRows.length === 0) return { pending: 0, resolved: 0 };

    // Same known-path source the chunk jobs use (repositoryIndex.service.ts).
    const { rows: pathRows } = await this.db.query(
      `SELECT DISTINCT file_path FROM repository_embeddings WHERE repository_id = $1`,
      [repositoryId],
    );
    const knownPaths = new Set<string>(pathRows.map((r) => r.file_path));

    const resolvedPending: { source: string; specifier: string }[] = [];
    // Two spellings of one import ("./x" and "./x.js") resolve to the same
    // target; ON CONFLICT DO UPDATE can't touch the same row twice in one
    // statement, so edges are deduped by (source, target) first.
    const edgesByKey = new Map<string, EdgeRow>();
    for (const r of pendingRows) {
      const target = resolveLocalImport(r.source_node_key, r.target_node_key, knownPaths);
      if (!target) continue;
      resolvedPending.push({ source: r.source_node_key, specifier: r.target_node_key });
      const key = `${r.source_node_key}\0${target}`;
      if (!edgesByKey.has(key)) {
        edgesByKey.set(key, { source: r.source_node_key, targetType: "file", targetKey: target, specifier: r.target_node_key });
      }
    }
    if (resolvedPending.length === 0) return { pending: pendingRows.length, resolved: 0 };

    await this.insertEdges(repositoryId, Array.from(edgesByKey.values()));
    await this.db.query(
      `DELETE FROM repository_relationships r
       USING unnest($2::text[], $3::text[]) AS p(source, specifier)
       WHERE r.repository_id = $1
         AND r.source_node_type = 'file'
         AND r.source_node_key = p.source
         AND r.target_node_type = 'pending'
         AND r.target_node_key = p.specifier
         AND r.relationship_type = 'IMPORTS'`,
      [repositoryId, resolvedPending.map((x) => x.source), resolvedPending.map((x) => x.specifier)],
    );

    return { pending: pendingRows.length, resolved: resolvedPending.length };
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
    // Includes its pending rows: their specifiers were relative to the old
    // location and are re-derived when the new path is indexed.
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
    // this UPDATE would violate the table's UNIQUE constraint. Filtered to
    // target_node_type = 'file': a pending key is a specifier, never a path,
    // and must never be retargeted.
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
   * Useful when a file is deleted. The source arm also clears the file's
   * pending rows; the target arm only matches real 'file' edges.
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
