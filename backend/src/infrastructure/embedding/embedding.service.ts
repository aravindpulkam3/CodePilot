import { GoogleGenAI } from "@google/genai";
import { createHash } from "crypto";
import { ChunkMetadata } from "../chunking/astChunking.service.js";
import { withCache } from "../../shared/utils/cache.js";

const EMBEDDING_MODEL = "gemini-embedding-001";
// Existing rows have no model-version column. Changing this model/task or
// dimensionality requires a full reindex; content hashes alone cannot detect it.
const EMBEDDING_DIMENSIONS = 3072;

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

    const textsToEmbed = chunks.map((chunk) => chunk.content);

    try {
      const response = await this.ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: textsToEmbed,
        config: {
          taskType: "RETRIEVAL_DOCUMENT",
        },
      });

      const embeddings = response?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
        throw new Error("Embedding response count does not match requested chunks");
      }
      // Gemini batchEmbedContents (and EmbedContentResponse in this SDK)
      // guarantees response order matches input order: https://ai.google.dev/api/embeddings
      // Map the requested chunks, so a missing array entry cannot be skipped.
      return chunks.map((chunk, index) => {
        const values = embeddings[index]?.values;
        if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`Invalid embedding dimensions for chunk ${index}`);
        }
        for (const value of values) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Invalid embedding value for chunk ${index}`);
          }
        }
        return { ...chunk, embedding: values };
      });
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
