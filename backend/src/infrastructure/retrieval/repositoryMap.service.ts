import { pool } from "../../config/db.js";
import { withCache } from "../../shared/utils/cache.js";
import { stripChunkHeader } from "../../shared/prompts/sourceRefs.js";
import { repositoryGraphService } from "../../features/repository/repositoryGraph.service.js";
import { initialModuleFor, INFRASTRUCTURE_MODULE_NAMES } from "./moduleDiscovery.service.js";
import { semanticRetrievalService } from "./semanticRetrieval.service.js";
import type { ModuleInventoryEntry } from "./retrievalTypes.js";
import {
  extractReadmePurpose,
  parseComposeServices,
  parsePackageManifest,
  renderModuleProfile,
  renderRepositoryProfile,
  selectBootstrapFiles,
  type ModuleProfileFacts,
  type RenderedProfile,
  type RepositoryProfileFacts,
} from "./repositoryProfileFacts.js";

const PROFILE_TTL_SECONDS = 600;
const EMPTY: RenderedProfile = { text: "", truncated: false };

const basenameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const depthOf = (p: string) => p.split("/").length;

/**
 * Deterministic orientation context for a repository, replacing the LLM
 * summary cascade. Everything is derived at query time from rows Phase 1
 * indexing already wrote — no LLM call, no extra table, no persisted copy.
 *
 * Profiles are cached under the INDEXED REVISION
 * (repoProfile:<id>:<last_indexed_sha>), so a profile computed for one commit
 * can never be served for another — no invalidation event has to fire.
 *
 * Profiles are orientation only. Every underlying fact stays fully
 * queryable from repository_embeddings / repository_imports.
 */
export class RepositoryMapService {
  private async indexedSha(repositoryId: string): Promise<string | null> {
    const { rows } = await pool.query(`SELECT last_indexed_sha FROM repositories WHERE id = $1`, [repositoryId]);
    return rows[0]?.last_indexed_sha ?? null;
  }

  /**
   * Every indexed code file grouped by initialModuleFor. Modules and the files
   * within each are ordered by summed import fan-in — the ordering Interview's
   * FRONTIER/NARROW blocks have always used, kept unchanged here. The profiles
   * below apply their own ordering and never treat fan-in as module importance.
   */
  public async buildModuleInventory(repositoryId: string): Promise<ModuleInventoryEntry[]> {
    const [allFiles, fanIn] = await Promise.all([
      semanticRetrievalService.listIndexedFilePaths(repositoryId),
      repositoryGraphService.getImportFanInCounts(repositoryId),
    ]);

    const byModule = new Map<string, string[]>();
    for (const file of allFiles) {
      const module = initialModuleFor(file);
      const files = byModule.get(module);
      if (files) files.push(file);
      else byModule.set(module, [file]);
    }

    const entries: ModuleInventoryEntry[] = Array.from(byModule.entries()).map(([module, files]) => {
      const ranked = [...files].sort((a, b) => (fanIn.get(b) ?? 0) - (fanIn.get(a) ?? 0));
      return { module, fileCount: ranked.length, files: ranked };
    });

    entries.sort((a, b) => {
      const fanInA = a.files.reduce((sum, f) => sum + (fanIn.get(f) ?? 0), 0);
      const fanInB = b.files.reduce((sum, f) => sum + (fanIn.get(f) ?? 0), 0);
      if (fanInB !== fanInA) return fanInB - fanInA;
      return b.fileCount - a.fileCount;
    });

    return entries;
  }

  public async getRepositoryProfile(repositoryId: string): Promise<RenderedProfile> {
    const sha = await this.indexedSha(repositoryId);
    if (!sha) return EMPTY;
    return withCache(`repoProfile:${repositoryId}:${sha}`, PROFILE_TTL_SECONDS, async () => {
      const [inventory, fanIn, docRows] = await Promise.all([
        this.buildModuleInventory(repositoryId),
        repositoryGraphService.getImportFanInCounts(repositoryId),
        pool.query(
          `SELECT file_path, start_line, chunk_total, content
           FROM repository_embeddings
           WHERE repository_id = $1 AND symbol_type = 'documentation'`,
          [repositoryId],
        ),
      ]);
      const rows: { file_path: string; start_line: number; chunk_total: number | null; content: string }[] = docRows.rows;

      // README purpose: shallowest README file, first section with prose.
      const readmeRows = rows
        .filter((r) => /^readme(\.|$)/i.test(basenameOf(r.file_path)))
        .sort((a, b) => depthOf(a.file_path) - depthOf(b.file_path) || a.file_path.localeCompare(b.file_path) || a.start_line - b.start_line);
      const readmePath = readmeRows[0]?.file_path;
      let purpose: string | null = null;
      for (const r of readmeRows.filter((x) => x.file_path === readmePath)) {
        purpose = extractReadmePurpose(stripChunkHeader(r.content));
        if (purpose) break;
      }

      // Manifest facts only from byte-exact whole-file rows (chunk_total IS NULL).
      // A file too large for one row stays retrievable but is left out here —
      // nothing is reconstructed from parts.
      const wholeFile = (pattern: RegExp) =>
        rows.filter((r) => pattern.test(basenameOf(r.file_path)) && r.chunk_total == null);
      const manifests = wholeFile(/^package\.json$/i)
        .map((r) => ({ filePath: r.file_path, manifest: parsePackageManifest(stripChunkHeader(r.content)) }))
        .filter((m): m is RepositoryProfileFacts["manifests"][number] => m.manifest !== null);
      const composeFiles = wholeFile(/^docker-compose([.-][\w.-]+)?\.ya?ml$/i).map((r) => ({
        filePath: r.file_path,
        services: parseComposeServices(stripChunkHeader(r.content)),
      }));

      const indexedPaths = inventory.flatMap((m) => m.files);
      const indexedSet = new Set(indexedPaths);
      const facts: RepositoryProfileFacts = {
        purpose,
        featureModules: inventory
          .filter((m) => !INFRASTRUCTURE_MODULE_NAMES.has(m.module))
          .map((m) => ({ module: m.module, fileCount: m.fileCount })),
        infrastructureModules: inventory
          .filter((m) => INFRASTRUCTURE_MODULE_NAMES.has(m.module))
          .map((m) => ({ module: m.module, fileCount: m.fileCount })),
        composeFiles,
        manifests,
        bootstrapFiles: selectBootstrapFiles(indexedPaths),
        mostReferencedFiles: Array.from(fanIn.entries())
          .filter(([path, count]) => count > 0 && indexedSet.has(path))
          .map(([path, count]) => ({ path, count })),
      };
      return renderRepositoryProfile(facts);
    });
  }

  public async getModuleProfile(repositoryId: string, module: string): Promise<RenderedProfile> {
    const sha = await this.indexedSha(repositoryId);
    if (!sha) return EMPTY;
    return withCache(`moduleProfile:${repositoryId}:${sha}:${module}`, PROFILE_TTL_SECONDS, async () => {
      const [inventory, fanIn] = await Promise.all([
        this.buildModuleInventory(repositoryId),
        repositoryGraphService.getImportFanInCounts(repositoryId),
      ]);
      const entry = inventory.find((m) => m.module === module);
      if (!entry) return EMPTY;
      const files = entry.files;

      // Cross-module edges are composed from the existing, audited graph
      // queries (resolved imports only) — no new import-graph SQL.
      const [symbolRows, depsByFile, dependentsByFile] = await Promise.all([
        pool.query(
          `SELECT file_path, qualified_name, MIN(start_line) AS first_line
           FROM repository_embeddings
           WHERE repository_id = $1 AND file_path = ANY($2::text[])
             AND is_exported = true AND parent_symbol IS NULL
             AND symbol_type <> 'documentation' AND qualified_name IS NOT NULL
           GROUP BY file_path, qualified_name`,
          [repositoryId, files],
        ),
        repositoryGraphService.getDirectDependenciesForFiles(repositoryId, files),
        repositoryGraphService.getDirectDependentsForFiles(repositoryId, files),
      ]);

      const fileRank = new Map(files.map((f, i) => [f, i]));
      const exportedSymbols = Array.from(
        new Set(
          (symbolRows.rows as { file_path: string; qualified_name: string; first_line: number }[])
            .sort((a, b) => (fileRank.get(a.file_path)! - fileRank.get(b.file_path)!) || a.first_line - b.first_line)
            .map((r) => r.qualified_name),
        ),
      );

      const countModules = (byFile: Map<string, string[]>) => {
        const counts = new Map<string, number>();
        for (const paths of byFile.values()) {
          for (const p of paths) {
            const other = initialModuleFor(p);
            if (other !== module) counts.set(other, (counts.get(other) ?? 0) + 1);
          }
        }
        return Array.from(counts.entries()).map(([m, edges]) => ({ module: m, edges }));
      };

      const facts: ModuleProfileFacts = {
        module,
        files: files.map((path) => ({ path, fanIn: fanIn.get(path) ?? 0 })),
        exportedSymbols,
        importsFrom: countModules(depsByFile),
        importedBy: countModules(dependentsByFile),
      };
      return renderModuleProfile(facts);
    });
  }
}

export const repositoryMapService = new RepositoryMapService();
