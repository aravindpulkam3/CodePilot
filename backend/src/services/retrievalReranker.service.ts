import { CORROBORATION_FACTOR, type RetrievalCandidate } from "../types/retrievalTypes.js";

/**
 * The effective strength of a single retrieval path for a candidate.
 * Exported so the budget service buckets by the SAME notion of "strongest"
 * that the reranker scores by — the two used to disagree.
 */
export function sourceStrength(source: { weight: number; similarity: number }): number {
  return source.weight * source.similarity;
}

/** The source that best explains why this candidate was retrieved. */
export function primarySource(candidate: RetrievalCandidate) {
  if (candidate.sources.length === 0) return undefined;
  return candidate.sources.reduce((best, s) =>
    sourceStrength(s) > sourceStrength(best) ? s : best,
  );
}

/**
 * Deterministic ordering for candidates.
 *
 * Score alone is not enough: exact ties still occur (identical content in two
 * files, or two chunks with the same cosine). Previously ties fell through to
 * Array.sort's stability, i.e. emission order — which depends on graph
 * traversal order, which is nondeterministic given indexQueue's concurrency.
 * Two reviews of the same PR could order context differently. The trailing
 * path/line comparison removes that.
 */
export function compareCandidates(a: RetrievalCandidate, b: RetrievalCandidate): number {
  if (b.score !== a.score) return b.score - a.score;

  const aSim = primarySource(a)?.similarity ?? 0;
  const bSim = primarySource(b)?.similarity ?? 0;
  if (bSim !== aSim) return bSim - aSim;

  const aPath = a.metadata.filePath ?? "";
  const bPath = b.metadata.filePath ?? "";
  if (aPath !== bPath) return aPath < bPath ? -1 : 1;

  return (a.metadata.startLine ?? 0) - (b.metadata.startLine ?? 0);
}

export class RetrievalRerankerService {
  /**
   * Scores candidates as: strongest path + a discounted bonus for corroboration.
   *
   *     score = max(weight * similarity) + 0.25 * sum(the rest)
   *
   * Previously this was an UNBOUNDED sum, so a candidate's score grew linearly
   * with how many paths happened to find it — four mediocre hits could beat a
   * direct hit on a modified file.
   *
   * What this does and does NOT guarantee, precisely: the discount alone does
   * not make `changed_file` unbeatable in the general case. What bounds it in
   * practice is that `retrieveReviewContext` assigns each file to exactly ONE
   * structural class (changed > test > dependent > dependency) and excludes
   * changed files from the semantic stage. So the reachable maxima are:
   *
   *   changed_file alone                    -> up to 1.0
   *   related_test + semantic_chunk         -> up to 0.85 + 0.25*0.45 = 0.9625
   *
   * i.e. a fully-relevant changed-file chunk still outranks the best possible
   * corroborated non-changed candidate. A weakly-matching changed-file chunk
   * can lose to a strongly-corroborated test — which is acceptable, because
   * the context budget gives the changed-code bucket an uncapped first pass
   * before any other class is allocated.
   */
  public rerankCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    for (const candidate of candidates) {
      const strengths = candidate.sources.map(sourceStrength);

      if (strengths.length === 0) {
        candidate.score = 0;
        continue;
      }

      const max = Math.max(...strengths);
      const rest = strengths.reduce((sum, s) => sum + s, 0) - max;
      candidate.score = max + CORROBORATION_FACTOR * rest;
    }

    return candidates.sort(compareCandidates);
  }
}

export const retrievalRerankerService = new RetrievalRerankerService();
