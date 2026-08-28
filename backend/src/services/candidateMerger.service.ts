import type { DroppedCandidate, RetrievalCandidate } from "../types/retrievalTypes.js";

export interface MergeResult {
  candidates: RetrievalCandidate[];
  dropped: DroppedCandidate[];
}

export class CandidateMergerService {
  /**
   * Merges multiple candidates (e.g. from semantic search and graph search)
   * that point to the exact same chunk or file, aggregating their provenance (sources).
   * Also returns candidates that were dropped due to deduplication.
   */
  public mergeCandidates(candidates: RetrievalCandidate[]): MergeResult {
    const mergedMap = new Map<string, RetrievalCandidate>();
    const dropped: DroppedCandidate[] = [];

    for (const candidate of candidates) {
      const existing = mergedMap.get(candidate.identityKey);
      
      if (existing) {
        // Record it as dropped due to deduplication
        dropped.push({ identityKey: candidate.identityKey, reason: "deduplicated" });

        // Merge sources, ensuring no duplicate source types exist with lower weights
        for (const newSource of candidate.sources) {
          const existingSourceIdx = existing.sources.findIndex(s => s.type === newSource.type);
          if (existingSourceIdx >= 0) {
            // Keep the higher weight if the same source type was found
            if (newSource.weight > existing.sources[existingSourceIdx].weight) {
              existing.sources[existingSourceIdx].weight = newSource.weight;
            }
          } else {
            existing.sources.push(newSource);
          }
        }
      } else {
        // Deep copy to prevent mutating the original inputs
        mergedMap.set(candidate.identityKey, {
          ...candidate,
          sources: [...candidate.sources]
        });
      }
    }

    return {
      candidates: Array.from(mergedMap.values()),
      dropped
    };
  }
}

export const candidateMergerService = new CandidateMergerService();
