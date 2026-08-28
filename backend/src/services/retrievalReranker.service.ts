import type { RetrievalCandidate } from "../types/retrievalTypes.js";

export class RetrievalRerankerService {
  /**
   * Applies a deterministic scoring algorithm to rank candidates.
   * Currently uses a simple sum of the source weights. 
   * A candidate retrieved via multiple paths (e.g. Exact Symbol + Semantic Search)
   * will score higher than one retrieved via a single path.
   */
  public rerankCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    for (const candidate of candidates) {
      // Calculate score based on sources
      let totalScore = 0;
      for (const source of candidate.sources) {
        totalScore += source.weight;
      }
      
      candidate.score = totalScore;
    }

    // Sort descending by score
    return candidates.sort((a, b) => b.score - a.score);
  }
}

export const retrievalRerankerService = new RetrievalRerankerService();
