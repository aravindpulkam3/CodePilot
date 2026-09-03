import type { RetrievalCandidate } from "../types/retrievalTypes.js";

export class RetrievalRerankerService {
  /**
   * Applies a deterministic scoring algorithm to rank candidates.
   * Sums weight * similarity across sources, so a candidate retrieved via
   * multiple paths (e.g. Exact Symbol + Semantic Search) scores higher than
   * one retrieved via a single path, AND two candidates found via the same
   * source type (e.g. two semantic_chunk hits) still rank against each
   * other by actual relevance instead of tying on a flat per-type weight.
   */
  public rerankCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    for (const candidate of candidates) {
      // Calculate score based on sources
      let totalScore = 0;
      for (const source of candidate.sources) {
        totalScore += source.weight * source.similarity;
      }

      candidate.score = totalScore;
    }

    // Sort descending by score
    return candidates.sort((a, b) => b.score - a.score);
  }
}

export const retrievalRerankerService = new RetrievalRerankerService();
