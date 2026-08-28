import type { Pool, PoolClient } from "pg";
import type { StoredSummaryRow, SummaryStore, NodeType } from "../types/summaryTypes.js"

function toPgVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function parsePgVector(text: string | null): number[] {
  if (!text) return [];
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .filter(Boolean)
    .map(Number);
}

export class PgSummaryStore implements SummaryStore {
  constructor(private db: Pool | PoolClient) {}

  public async get(
    repositoryId: string,
    nodeType: NodeType,
    nodeKey: string,
  ): Promise<StoredSummaryRow | null> {
    const result = await this.db.query(
      `SELECT id, repository_id, node_type, node_key, parent_key, summary_json,
              content_hash, embedding::text AS embedding, created_at, updated_at
       FROM repository_summaries
       WHERE repository_id = $1 AND node_type = $2 AND node_key = $3
       LIMIT 1`,
      [repositoryId, nodeType, nodeKey],
    );

    if (result.rowCount === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      repository_id: row.repository_id,
      node_type: row.node_type,
      node_key: row.node_key,
      parent_key: row.parent_key,
      summary_json: row.summary_json, // pg driver parses jsonb into an object automatically
      content_hash: row.content_hash,
      embedding: parsePgVector(row.embedding),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  public async getAllFiles(repositoryId: string): Promise<StoredSummaryRow[]> {
    const result = await this.db.query(
      `SELECT id, repository_id, node_type, node_key, parent_key, summary_json,
              content_hash, embedding::text AS embedding, created_at, updated_at
       FROM repository_summaries
       WHERE repository_id = $1 AND node_type = 'file'`,
      [repositoryId],
    );

    return result.rows.map(row => ({
      id: row.id,
      repository_id: row.repository_id,
      node_type: row.node_type,
      node_key: row.node_key,
      parent_key: row.parent_key,
      summary_json: row.summary_json,
      content_hash: row.content_hash,
      embedding: parsePgVector(row.embedding),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  public async delete(repositoryId: string, nodeType: NodeType, nodeKey: string): Promise<void> {
    await this.db.query(
      `DELETE FROM repository_summaries
       WHERE repository_id = $1 AND node_type = $2 AND node_key = $3`,
      [repositoryId, nodeType, nodeKey],
    );
  }

  public async upsert(
    row: Omit<StoredSummaryRow, "id" | "created_at" | "updated_at">,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO repository_summaries
         (repository_id, node_type, node_key, parent_key, summary_json, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::vector)
       ON CONFLICT (repository_id, node_type, node_key)
       DO UPDATE SET
         parent_key   = EXCLUDED.parent_key,
         summary_json = EXCLUDED.summary_json,
         content_hash = EXCLUDED.content_hash,
         embedding    = EXCLUDED.embedding,
         updated_at   = now()`,
      [
        row.repository_id,
        row.node_type,
        row.node_key,
        row.parent_key,
        JSON.stringify(row.summary_json),
        row.content_hash,
        toPgVectorLiteral(row.embedding),
      ],
    );
  }
}