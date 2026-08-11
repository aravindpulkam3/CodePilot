import { GoogleGenAI } from "@google/genai";
import { ChunkMetadata } from "./astChunking.service.js";
import type { EmbeddingClient } from "../types/summaryTypes.js";

export class EmbeddingService implements EmbeddingClient {
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

    console.log("came to generate embeddings")

    const enrichedChunks: (ChunkMetadata & { embedding: number[] })[] = [];

    const textsToEmbed = chunks.map((chunk) => chunk.content);

    try {
      const response = await this.ai.models.embedContent({
        model: "gemini-embedding-001",
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
    try {
      const response = await this.ai.models.embedContent({
        model: "gemini-embedding-001",
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

      return vectorValues;
    } catch (error) {
      console.error("Error embedding query:", error);
      throw error;
    }
  }

  // Generic single-text embed for anything that isn't a ChunkMetadata[] batch
  // and isn't a query — e.g. repository/architecture/component/file summary
  // text. Summaries are stored documents, so this defaults to
  // RETRIEVAL_DOCUMENT, matching the task type generateEmbeddings() already
  // uses for chunks.
  public async embedText(
    text: string,
    taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT",
  ): Promise<number[]> {
    try {
      const response = await this.ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: [text],
        config: {
          taskType,
        },
      });

      const vectorValues = response.embeddings?.[0]?.values;
      if (!vectorValues || vectorValues.length === 0) {
        throw new Error("Failed to generate embedding for text.");
      }

      return vectorValues;
    } catch (error) {
      console.error("Error embedding text:", error);
      throw error;
    }
  }

  // This is what makes `implements EmbeddingClient` on the class above
  // actually true — the interface requires a method literally named
  // `embed` taking one string and returning Promise<number[]>. embedText()
  // already does that work; this just satisfies the exact contract shape,
  // defaulting to RETRIEVAL_DOCUMENT since summaries are stored documents.
  public async embed(text: string): Promise<number[]> {
    return this.embedText(text, "RETRIEVAL_DOCUMENT");
  }
}

export const embedder = new EmbeddingService();