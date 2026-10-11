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
   * raw relative specifiers retained for future re-resolution.
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

    // 2. Insert resolved edges and raw specifiers in one batch.
    if (imports.length > 0) {
      await this.insertImports(
        repositoryId,
        imports.flatMap((imp): ImportRow[] => [
          // Keep source spelling even after resolution so later renames can be
          // checked against the complete new path set. Graph reads filter resolved.
          { source: filePath, target: imp.specifier, resolved: false },
          ...(imp.resolvedPath ? [{ source: filePath, target: imp.resolvedPath, resolved: true }] : []),
        ]),
      );
    }
  }

  /**
   * Re-resolves every retained relative import specifier for the repository against
   * its now-complete file list. Called from the finalize transaction once
   * every index chunk of a run has committed, so edges lost because their
   * target sat in a later 50-file chunk are recovered. The rest stay
   * unresolved (a genuinely missing file, or a specifier shape
   * resolveLocalImport doesn't handle) and are retried on the next finalize. Raw spellings remain after resolution.
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

    for (const r of pendingRows) {
      const target = resolveLocalImport(r.source_path, r.target, knownPaths);
      if (!target) continue;
      resolvedRows.push({ source: r.source_path, target, resolved: true });
    }
    // Rename/deletion and changed-source handling already remove affected
    // resolved edges. Do not clear every edge of these importers: legacy rows
    // may retain only their formerly unresolved spellings, not a complete set.
    await this.insertImports(repositoryId, resolvedRows);
    return { pending: pendingRows.length, resolved: resolvedRows.length };
  }

  /** Rename metadata alone never proves that an importer changed its spelling. */
  public async renameFileRelationships(
    repositoryId: string,
    oldPath: string,
    _newPath: string,
  ): Promise<void> {
    // Outgoing imports are rebuilt from the new source. Retained raw incoming
    // specifiers are re-resolved at finalization; legacy edges lacking them are
    // omitted conservatively until their importer is indexed again.
    await this.db.query(
      `DELETE FROM repository_imports WHERE repository_id = $1
       AND (source_path = $2 OR (resolved AND target = $2))`,
      [repositoryId, oldPath],
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
