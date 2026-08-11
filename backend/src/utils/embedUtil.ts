import type { EmbeddingClient, SummaryJSON } from "../types/summaryTypes.js";

// Per the spec: embed purpose + summary + responsibilities + keywords, never
// raw JSON. Field names differ slightly per node type, so this is a switch
// rather than one generic reducer over common keys.
export function buildEmbeddingText(summary: SummaryJSON): string {
  switch (summary.nodeType) {
    case "file":
      return [
        summary.purpose,
        summary.summary,
        summary.responsibilities.join(". "),
        summary.keywords.join(", "),
      ]
        .filter(Boolean)
        .join("\n");

    case "component":
      return [
        summary.purpose,
        summary.summary,
        summary.responsibilities.join(". "),
        summary.keywords.join(", "),
      ]
        .filter(Boolean)
        .join("\n");

    case "architecture":
      return [
        summary.summary,
        summary.architectureStyle,
        summary.majorLayers.join(", "),
        summary.requestFlows.join(". "),
        summary.crossCuttingConcerns.join(", "),
        summary.keywords.join(", "),
      ]
        .filter(Boolean)
        .join("\n");

    case "repository":
      return [
        summary.purpose,
        summary.summary,
        summary.features.join(". "),
        summary.keywords.join(", "),
      ]
        .filter(Boolean)
        .join("\n");
  }
}

export async function embedSummary(summary: SummaryJSON, embeddings: EmbeddingClient): Promise<number[]> {
  const text = buildEmbeddingText(summary);
  return embeddings.embed(text);
}