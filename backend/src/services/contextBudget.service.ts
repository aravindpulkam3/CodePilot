import type { DroppedCandidate, RetrievalCandidate } from "../types/retrievalTypes.js";
import { compareCandidates, primarySource } from "./retrievalReranker.service.js";

export interface BudgetResult {
  accepted: RetrievalCandidate[];
  dropped: DroppedCandidate[];
  budget: {
    changedCodeTokens: number;
    graphTokens: number;
    testTokens: number;
    semanticTokens: number;
    totalTokens: number;
  };
}

export class ContextBudgetService {
  /**
   * Applies a categorical context budget to the sorted list of candidates.
   * 
   * Strategy:
   * 1. Changed Code (changed_file) is uncapped, bounded only by maxTokens.
   * 2. Remaining budget is divided:
   *    - Graph (dependents + dependencies): 35%
   *    - Tests (related_test): 20%
   *    - Semantic (chunks): 45%
   * 3. Two-pass allocation: Fill quotas first, then use any remaining global tokens
   *    to fill remaining candidates in strict rank order (overflow).
   *
   * Bucketing keys on the candidate's STRONGEST source, not `sources[0]`.
   * `sources[0]` is whichever path found it first — the merger appends later
   * ones — so a file discovered as a dependency and only later recognised as a
   * related test was budgeted as graph despite carrying the higher weight.
   */
  public allocateBudget(candidates: RetrievalCandidate[], maxTokens: number): BudgetResult {
    const accepted: RetrievalCandidate[] = [];
    const dropped: DroppedCandidate[] = [];
    let currentTotalTokens = 0;

    const stats = {
      changedCodeTokens: 0,
      graphTokens: 0,
      testTokens: 0,
      semanticTokens: 0,
      totalTokens: 0
    };

    // Very naive approximation of tokens
    const estimateTokens = (c: RetrievalCandidate) => Math.ceil((c.content.length || 0) / 4);

    // 1. Separate into categories (maintaining sorted order inside each)
    const changedCode: RetrievalCandidate[] = [];
    const graph: RetrievalCandidate[] = [];
    const tests: RetrievalCandidate[] = [];
    const semantic: RetrievalCandidate[] = [];

    for (const c of candidates) {
      const type = primarySource(c)?.type;
      if (type === "changed_file") {
        changedCode.push(c);
      } else if (type === "related_test") {
        tests.push(c);
      } else if (type === "semantic_chunk") {
        semantic.push(c);
      } else {
        // graph_dependent / graph_dependency
        graph.push(c);
      }
    }

    // 2. Allocate Changed Code (Uncapped, except by absolute maxToken limit)
    for (const c of changedCode) {
      const cost = estimateTokens(c);
      if (currentTotalTokens + cost <= maxTokens) {
        accepted.push(c);
        currentTotalTokens += cost;
        stats.changedCodeTokens += cost;
      } else {
        dropped.push({ identityKey: c.identityKey, reason: "budget_capped" });
      }
    }

    // 3. Define quotas for remaining budget
    const remainingForQuotas = Math.max(0, maxTokens - currentTotalTokens);
    const graphBudget = Math.floor(remainingForQuotas * 0.35);
    const testBudget = Math.floor(remainingForQuotas * 0.20);
    const semanticBudget = Math.floor(remainingForQuotas * 0.45);

    const pendingOverflow: RetrievalCandidate[] = [];

    // Helper for First Pass
    const fillBucket = (bucketCandidates: RetrievalCandidate[], bucketLimit: number, statKey: "graphTokens"|"testTokens"|"semanticTokens") => {
        let bucketSpent = 0;
        for (const c of bucketCandidates) {
            const cost = estimateTokens(c);
            if (bucketSpent + cost <= bucketLimit && currentTotalTokens + cost <= maxTokens) {
                accepted.push(c);
                bucketSpent += cost;
                currentTotalTokens += cost;
                stats[statKey] += cost;
            } else {
                pendingOverflow.push(c); // Try again in overflow pass
            }
        }
    };

    fillBucket(graph, graphBudget, "graphTokens");
    fillBucket(tests, testBudget, "testTokens");
    fillBucket(semantic, semanticBudget, "semanticTokens");

    // 4. Pass 2 (Overflow): Re-sort pending candidates by score and fill any remaining total budget
    pendingOverflow.sort(compareCandidates);

    for (const c of pendingOverflow) {
        const cost = estimateTokens(c);
        if (currentTotalTokens + cost <= maxTokens) {
            accepted.push(c);
            currentTotalTokens += cost;

            // Re-attribute to stats, using the same strongest-source rule as
            // the bucketing above so the two can't disagree.
            const type = primarySource(c)?.type;
            if (type === "changed_file") stats.changedCodeTokens += cost;
            else if (type === "related_test") stats.testTokens += cost;
            else if (type === "semantic_chunk") stats.semanticTokens += cost;
            else stats.graphTokens += cost;
        } else {
            dropped.push({ identityKey: c.identityKey, reason: "budget_capped" });
        }
    }

    // Finally, sort accepted back to rank order (deterministic — see compareCandidates)
    accepted.sort(compareCandidates);

    stats.totalTokens = currentTotalTokens;

    return { accepted, dropped, budget: stats };
  }
}

export const contextBudgetService = new ContextBudgetService();
