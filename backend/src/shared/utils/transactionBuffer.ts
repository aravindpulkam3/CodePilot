import type { LocalImport } from "./importResolver.js";

export interface IRelationshipIndexer {
  deleteFileRelationships(repositoryId: string, filePath: string): Promise<void>;
  indexFileRelationships(
    repositoryId: string,
    filePath: string,
    imports: LocalImport[]
  ): Promise<void>;
  renameFileRelationships(
    repositoryId: string,
    oldPath: string,
    newPath: string
  ): Promise<void>;
}

export class MemoryRelationshipIndexer implements IRelationshipIndexer {
  public pendingDeletes = new Set<string>(); // file paths
  public pendingImports = new Map<string, LocalImport[]>(); // file path -> imports (resolvedPath null = pending)
  public pendingRenames: { oldPath: string; newPath: string }[] = [];

  public async deleteFileRelationships(repositoryId: string, filePath: string): Promise<void> {
    this.pendingImports.delete(filePath);
    this.pendingDeletes.add(filePath);
  }

  /**
   * Buffers a rename. Flushed BEFORE pendingDeletes/pendingImports so the
   * retarget sees the pre-rename rows still in place — see
   * repositoryIndex.service.ts's persistence stage.
   */
  public async renameFileRelationships(
    repositoryId: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    this.pendingImports.delete(oldPath);
    this.pendingRenames.push({ oldPath, newPath });
  }

  public async indexFileRelationships(
    repositoryId: string,
    filePath: string,
    imports: LocalImport[]
  ): Promise<void> {
    this.pendingImports.set(filePath, imports);
  }
}
