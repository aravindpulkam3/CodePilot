import type { PoolClient } from "pg";
import { resolveLocalImport, type LocalImport } from "../../shared/utils/importResolver.js";

interface ImportRow {
  source: string;
  /** The imported file's path when resolved; the raw relative specifier otherwise. */
  target: string;
  resolved: boolean;
}

/** Rows per multi-VALUES insert — keeps the statement far below Postgres' 65535 bind-parameter limit. */
const INSERT_BATCH_SIZE = 500;

/** Writes the file-level import graph (repository_imports) inside the indexing transaction. */
export class RelationshipIndexingService {
  constructor(private db: PoolClient) {}

  /** Duplicate rows (two spellings of one import resolving to the same file) are skipped by ON CONFLICT. */
  private async insertImports(repositoryId: string, rows: ImportRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
      const values: string[] = [];
      const params: any[] = [];
      let p = 1;
      for (const row of batch) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(repositoryId, row.source, row.target, row.resolved);
      }
      await this.db.query(
        `INSERT INTO repository_imports (repository_id, source_path, target, resolved)
         VALUES ${values.join(", ")}
         ON CONFLICT DO NOTHING`,
        params,
      );
    }
  }

  /**
   * Replaces all imports recorded for a given file: resolved edges, plus
   * unresolved rows for relative imports whose target isn't known yet.
   */
  public async indexFileRelationships(
    repositoryId: string,
    filePath: string,
    imports: LocalImport[]
  ): Promise<void> {
    // 1. Delete the file's old imports — resolved and unresolved alike, so
    // re-indexing a file also clears its stale unresolved rows.
    await this.db.query(
      `DELETE FROM repository_imports WHERE repository_id = $1 AND source_path = $2`,
      [repositoryId, filePath]
    );

    // 2. Insert resolved edges and unresolved specifiers in one batch.
    if (imports.length > 0) {
      await this.insertImports(
        repositoryId,
        imports.map((imp): ImportRow =>
          imp.resolvedPath
            ? { source: filePath, target: imp.resolvedPath, resolved: true }
            : { source: filePath, target: imp.specifier, resolved: false },
        ),
      );
    }
  }

  /**
   * Re-resolves every unresolved relative import for the repository against
   * its now-complete file list. Called from the finalize transaction once
   * every index chunk of a run has committed, so edges lost because their
   * target sat in a later 50-file chunk are recovered. The rest stay
   * unresolved (a genuinely missing file, or a specifier shape
   * resolveLocalImport doesn't handle) and are retried on the next finalize.
   */
  public async resolvePendingImports(repositoryId: string): Promise<{ pending: number; resolved: number }> {
    const { rows: pendingRows } = await this.db.query(
      `SELECT source_path, target FROM repository_imports
       WHERE repository_id = $1 AND NOT resolved`,
      [repositoryId],
    );
    if (pendingRows.length === 0) return { pending: 0, resolved: 0 };

    // Same known-path source the chunk jobs use (repositoryIndex.service.ts).
    const { rows: pathRows } = await this.db.query(
      `SELECT DISTINCT file_path FROM repository_embeddings WHERE repository_id = $1`,
      [repositoryId],
    );
    const knownPaths = new Set<string>(pathRows.map((r) => r.file_path));

    const resolvedRows: ImportRow[] = [];
    const resolvedPending: { source: string; specifier: string }[] = [];
    for (const r of pendingRows) {
      const target = resolveLocalImport(r.source_path, r.target, knownPaths);
      if (!target) continue;
      resolvedRows.push({ source: r.source_path, target, resolved: true });
      resolvedPending.push({ source: r.source_path, specifier: r.target });
    }
    if (resolvedRows.length === 0) return { pending: pendingRows.length, resolved: 0 };

    await this.insertImports(repositoryId, resolvedRows);
    await this.db.query(
      `DELETE FROM repository_imports i
       USING unnest($2::text[], $3::text[]) AS p(source, specifier)
       WHERE i.repository_id = $1
         AND i.source_path = p.source
         AND i.target = p.specifier
         AND NOT i.resolved`,
      [repositoryId, resolvedPending.map((x) => x.source), resolvedPending.map((x) => x.specifier)],
    );

    return { pending: pendingRows.length, resolved: resolvedPending.length };
  }

  /**
   * Moves a file's imports from its old path to its new one.
   *
   * NOT the same as delete-then-reindex. The renamed file's OUTGOING imports
   * are dropped (the caller re-indexes them from the new content in this same
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
    // 1. Outgoing imports of the renamed file — rebuilt from its new content.
    // Includes its unresolved rows: their specifiers were relative to the old
    // location and are re-derived when the new path is indexed.
    await this.db.query(
      `DELETE FROM repository_imports WHERE repository_id = $1 AND source_path = $2`,
      [repositoryId, oldPath]
    );

    // 2. Incoming edges -> point them at the new path. ON CONFLICT skips an
    // importer that already has an edge to newPath (a rename that overwrites a
    // file the importer also imported). Resolved rows only: an unresolved
    // row's target is a specifier, never a path, and must not be retargeted.
    await this.db.query(
      `INSERT INTO repository_imports (repository_id, source_path, target, resolved)
       SELECT repository_id, source_path, $3, TRUE
       FROM repository_imports
       WHERE repository_id = $1 AND target = $2 AND resolved
       ON CONFLICT DO NOTHING`,
      [repositoryId, oldPath, newPath]
    );
    await this.db.query(
      `DELETE FROM repository_imports WHERE repository_id = $1 AND target = $2 AND resolved`,
      [repositoryId, oldPath]
    );
  }

  /**
   * Clears all imports where this file is either the importer or the
   * imported file. Used when a file is deleted. The importer arm also clears
   * the file's unresolved rows; the target arm only matches resolved edges.
   */
  public async deleteFileRelationships(repositoryId: string, filePath: string): Promise<void> {
    await this.db.query(
      `DELETE FROM repository_imports
       WHERE repository_id = $1
         AND (source_path = $2 OR (resolved AND target = $2))`,
      [repositoryId, filePath]
    );
  }
}
