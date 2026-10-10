import type { Review, ReviewInputMetadata } from "../types/reviewTypes.ts";

export function reviewRevisionState(
  review: Pick<Review, "head_sha" | "base_sha"> | null,
  pr: { head_sha: string; base_sha: string } | null | undefined,
): "current" | "outdated" | "unknown" {
  if (!review || !pr) return "unknown";
  if (review.head_sha !== pr.head_sha || (review.base_sha && review.base_sha !== pr.base_sha)) return "outdated";
  return review.base_sha ? "current" : "unknown";
}

export function reviewCoverageLabel(input: ReviewInputMetadata): string {
  const eligible = input.files.filter((file) => file.status !== "excluded");
  const included = eligible.filter((file) => file.inclusion !== "none").length;
  const partial = eligible.filter((file) => file.inclusion === "partial").length;
  const unavailable = eligible.filter((file) => file.status === "unavailable").length;
  return `${input.coverage === "partial" ? "Partial review" : "Review input"}: ${included} of ${eligible.length} eligible files included; ${partial} partially included, ${unavailable} unavailable.`;
}
