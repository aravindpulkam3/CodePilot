import type { EmbeddingClient, SummaryJSON } from "../types/summaryTypes.js";

// Per the spec: embed purpose + summary + responsibilities + keywords, never
// raw JSON. Field names differ slightly per node type, so this is a switch
// rather than one generic reducer over common keys.
export function buildEmbeddingText(summary: SummaryJSON): string {
  const nodeType = String(summary.nodeType || "").toLowerCase();

  switch (nodeType) {
    case "file": {
      const s = summary as import("../types/summaryTypes.js").FileSummary;
      return [
        s.purpose,
        s.summary,
        s.responsibilities?.join(". "),
        s.keywords?.join(", "),
      ].filter(Boolean).join("\n");
    }
    case "component": {
      const s = summary as import("../types/summaryTypes.js").ComponentSummary;
      return [
        s.purpose,
        s.summary,
        s.responsibilities?.join(". "),
        s.keywords?.join(", "),
      ].filter(Boolean).join("\n");
    }
    case "architecture": {
      const s = summary as import("../types/summaryTypes.js").ArchitectureSummary;
      return [
        s.summary,
        s.architectureStyle,
        s.majorLayers?.join(", "),
        s.requestFlows?.join(". "),
        s.crossCuttingConcerns?.join(", "),
        s.keywords?.join(", "),
      ].filter(Boolean).join("\n");
    }
    case "repository": {
      const s = summary as import("../types/summaryTypes.js").RepositorySummary;
      return [
        s.purpose,
        s.summary,
        s.features?.join(". "),
        s.keywords?.join(", "),
      ].filter(Boolean).join("\n");
    }
    default:
      return [
        summary.summary,
        (summary as any).purpose,
        JSON.stringify(summary)
      ].filter(Boolean).join("\n");
  }
}

export async function embedSummary(summary: SummaryJSON, embeddings: EmbeddingClient): Promise<number[]> {
  const text = buildEmbeddingText(summary);
  return embeddings.embed(text);
}