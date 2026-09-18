import { GoogleGenAI } from "@google/genai";
import { createHash } from "crypto";
import { ChunkMetadata } from "../chunking/astChunking.service.js";
import { withCache } from "../../shared/utils/cache.js";

const EMBEDDING_MODEL = "gemini-embedding-001";

export class EmbeddingService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({});
  }

  public async generateEmbeddings(
    chunks: ChunkMetadata[],
  ): Promise<(ChunkMetadata & { embedding: number[] })[]> {
    if (!chunks || chunks.length === 0) {
      return [];
    }

    console.log(`[Embedding] Embedding ${chunks.length} chunk(s) as RETRIEVAL_DOCUMENT.`);

    const enrichedChunks: (ChunkMetadata & { embedding: number[] })[] = [];

    const textsToEmbed = chunks.map((chunk) => chunk.content);

    try {
      const response = await this.ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: textsToEmbed,
        config: {
          taskType: "RETRIEVAL_DOCUMENT",
        },
      });

      // 1. Check if embeddings array exists
      if (!response || !response.embeddings) {
        console.warn(
          "Warning: Embedding API returned an empty or undefined embeddings array.",
        );
        return [];
      }

      // 2. Safely map the response back to our chunks
      response.embeddings.forEach((emb, index) => {
        // Safely extract values. If undefined or null, fallback to an empty array.
        const vectorValues = emb.values || [];

        // 3. Ensure the vector actually contains data before pushing
        if (vectorValues.length > 0) {
          enrichedChunks.push({
            ...chunks[index],
            embedding: vectorValues,
          });
        } else {
          console.warn(
            `Warning: Vector generation failed for chunk at index ${index}`,
          );
        }
      });

      return enrichedChunks;
    } catch (error) {
      console.error("Error generating embeddings:", error);
      throw error;
    }
  }

  public async embedQuery(queryText: string): Promise<number[]> {
    const hash = createHash("sha256").update(queryText).digest("hex");
    return withCache(`embed:query:${EMBEDDING_MODEL}:${hash}`, 3600, async () => {
      try {
        const response = await this.ai.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: [queryText],
          config: {
            // Crucial: Tells the model this is a search query, not a stored document
            taskType: "RETRIEVAL_QUERY",
          },
        });

        const vectorValues = response.embeddings?.[0]?.values;
        if (!vectorValues || vectorValues.length === 0) {
          throw new Error("Failed to generate embedding for query.");
        }

        // Log the shape, never the vector itself — dumping 3072 floats on every
        // query buries every other log line in the process.
        console.log(`[Embedding] Query embedded as RETRIEVAL_QUERY (dim=${vectorValues.length}).`);

        return vectorValues;
      } catch (error) {
        console.error("Error embedding query:", error);
        throw error;
      }
    });
  }

}

export const embedder = new EmbeddingService();