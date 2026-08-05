import { getAuth } from "@clerk/express";
import { pool } from "../config/db.js";
import { embedder } from "./embedding.service.js";
import { repositorySyncService } from "./repositorySync.service.js";

export interface RetrievedContext {
  file_path: string;
  symbol_type: string;
  symbol_name: string;
  start_line: number;
  end_line: number;
  content: string;
  similarity_score: number;
}

export class RetrievalService {
  /**
   * @param repositoryId
   * @param queryText
   * @param limit
   */
  public async searchRepository(
    clerkUserId:string,
    repositoryId: string,
    queryText: string,
    limit: number = 5,
  ): Promise<RetrievedContext[]> {
    // 1. Convert the search string into a 3072-dimensional vector

    

    console.log(
        `[ReviewService] JIT Sync check for repository ${repositoryId}...`,
      );
      // This will instantly return if the Webhook already updated the DB.
      // If the webhook dropped, it will self-heal and index the missing files now.
      await repositorySyncService.syncRepository(clerkUserId, repositoryId);
      console.log(
        `[ReviewService] Repository is guaranteed up to date. Proceeding...`,
      );

    console.log("came to retrieve");
    
    const queryVector = await embedder.embedQuery(queryText);

    // Format for pgvector: "[0.1, -0.2, ...]"
    const queryVectorStr = `[${queryVector.join(",")}]`;

    const client = await pool.connect();
    try {
      // 2. Perform Vector Search using Cosine Distance (<=>)
      // We calculate `1 - distance` to get a similarity score between 0 and 1.
      const { rows } = await client.query(
        `SELECT 
                file_path, 
                symbol_type, 
                symbol_name, 
                start_line, 
                end_line, 
                content,
                 1 - (embedding <=> $1::vector) AS similarity_score
                FROM repository_embeddings
                WHERE repository_id = $2
                ORDER BY embedding <=> $1::vector
                 LIMIT $3`,
        [queryVectorStr, repositoryId, limit],
      );
      console.log(
        "retrieved context",
        rows.length,
        rows[0].file_path,
        rows[1].file_path,
      );

      return rows as RetrievedContext[];
    } finally {
      client.release();
    }
  }
}

export const retrievalService = new RetrievalService();
