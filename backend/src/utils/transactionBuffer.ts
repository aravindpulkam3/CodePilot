import type { SummaryStore, StoredSummaryRow, NodeType } from "../types/summaryTypes.js";

export interface IRelationshipIndexer {
  deleteFileRelationships(repositoryId: string, filePath: string): Promise<void>;
  indexFileRelationships(
    repositoryId: string,
    filePath: string,
    imports: { resolvedPath: string; specifier: string }[]
  ): Promise<void>;
}

export class MemorySummaryStore implements SummaryStore {
  public pendingUpserts = new Map<string, Omit<StoredSummaryRow, "id" | "created_at" | "updated_at">>();
  public pendingDeletes = new Map<string, { repositoryId: string, nodeType: NodeType, nodeKey: string }>();

  constructor(private baseStore: SummaryStore) {}

  private getKey(nodeType: NodeType, nodeKey: string) {
    return `${nodeType}:${nodeKey}`;
  }

  public async get(repositoryId: string, nodeType: NodeType, nodeKey: string): Promise<StoredSummaryRow | null> {
    const key = this.getKey(nodeType, nodeKey);
    if (this.pendingDeletes.has(key)) return null;
    
    if (this.pendingUpserts.has(key)) return this.pendingUpserts.get(key) as StoredSummaryRow;
    return this.baseStore.get(repositoryId, nodeType, nodeKey);
  }

  public async getAllFiles(repositoryId: string): Promise<StoredSummaryRow[]> {
    const baseFiles = await this.baseStore.getAllFiles(repositoryId);
    const result = new Map<string, StoredSummaryRow>();
    
    for (const f of baseFiles) {
      const key = this.getKey(f.node_type as NodeType, f.node_key);
      if (!this.pendingDeletes.has(key)) {
        result.set(key, f);
      }
    }
    
    for (const [key, val] of this.pendingUpserts.entries()) {
      if (val.node_type === 'file') {
        result.set(key, val as StoredSummaryRow);
      }
    }
    
    return Array.from(result.values());
  }

  public async delete(repositoryId: string, nodeType: NodeType, nodeKey: string): Promise<void> {
    const key = this.getKey(nodeType, nodeKey);
    this.pendingUpserts.delete(key);
    this.pendingDeletes.set(key, { repositoryId, nodeType, nodeKey });
  }

  public async upsert(row: Omit<StoredSummaryRow, "id" | "created_at" | "updated_at">): Promise<void> {
    const key = this.getKey(row.node_type as NodeType, row.node_key);
    this.pendingDeletes.delete(key);
    
    this.pendingUpserts.set(key, row);
  }
}

export class MemoryRelationshipIndexer implements IRelationshipIndexer {
  public pendingDeletes = new Set<string>(); // file paths
  public pendingImports = new Map<string, { resolvedPath: string; specifier: string }[]>(); // file path -> imports

  public async deleteFileRelationships(repositoryId: string, filePath: string): Promise<void> {
    this.pendingImports.delete(filePath);
    this.pendingDeletes.add(filePath);
  }

  public async indexFileRelationships(
    repositoryId: string,
    filePath: string,
    imports: { resolvedPath: string; specifier: string }[]
  ): Promise<void> {
    this.pendingImports.set(filePath, imports);
  }
}
