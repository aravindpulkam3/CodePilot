import type { PullRequestFile } from "../../infrastructure/github/pullRequestSnapshot.js";
import type { LLMRequestBudget } from "../../infrastructure/llm/requestBudget.js";
import type { StructuredReview } from "./review.service.js";

export const REVIEW_SEVERITIES = ["Info", "Minor", "Major", "Critical"];
export const REVIEW_RISKS = ["Low", "Medium", "High", "Critical"];
export const REVIEW_CATEGORIES = [
  "correctness", "security", "performance", "maintainability",
  "best_practices", "testing", "positive_feedback", "documentation",
];

export interface ReviewHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  included: boolean;
}

export interface ReviewFileCoverage {
  filename: string;
  previousFilename?: string;
  status: "available" | "excluded" | "unavailable";
  inclusion: "full" | "partial" | "none";
  reason?: string;
  hunks: ReviewHunk[];
  /** Supporting source for included hunks only; independent of diff inclusion. */
  enclosing?: {
    status: "complete" | "partial" | "unavailable" | "not-applicable";
    uncovered: string[];
    reason?: string;
    split: boolean;
  };
}

export interface ReviewInputMetadata {
  version: 1;
  headSha: string;
  baseSha: string;
  acquisition: {
    complete: boolean;
    expectedFiles: number;
    fetchedFiles: number;
  };
  coverage: "complete" | "partial";
  files: ReviewFileCoverage[];
  excludedEvidence: Array<{ filename: string; reason: string }>;
  budget: LLMRequestBudget & {
    estimatedInputTokens: number;
    method: "utf8-bytes";
  };
}

/** Return complete, count-validated hunks only; truncated/opaque patches are unavailable. */
export function splitReviewPatch(
  file: PullRequestFile,
): Array<{ text: string; hunk: ReviewHunk }> | null {
  if (!file.patch?.trim()) return null;
  const lines = file.patch.split("\n");
  const result: Array<{ text: string; hunk: ReviewHunk }> = [];
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < lines.length; ) {
    const header = lines[i];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!match) return null;
    const hunk: ReviewHunk = {
      header,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      included: false,
    };
    const start = i++;
    let oldCount = 0;
    let newCount = 0;
    while (i < lines.length && !lines[i].startsWith("@@ ")) {
      const line = lines[i];
      if (line.startsWith("+")) {
        newCount++;
        additions++;
      } else if (line.startsWith("-")) {
        oldCount++;
        deletions++;
      } else if (line.startsWith(" ")) {
        oldCount++;
        newCount++;
      } else if (line.startsWith("\\ No newline at end of file")) {
        /* no source line */
      } else if (line === "" && i === lines.length - 1) {
        i++;
        break;
      } else return null;
      i++;
    }
    if (oldCount !== hunk.oldLines || newCount !== hunk.newLines) return null;
    result.push({
      text: lines.slice(start, i).join("\n").replace(/\n$/, ""),
      hunk,
    });
  }
  if (
    (file.additions !== undefined && file.additions !== additions) ||
    (file.deletions !== undefined && file.deletions !== deletions)
  )
    return null;
  return result.length ? result : null;
}

export function reviewCoverageMessage(input: ReviewInputMetadata): string {
  const eligible = input.files.filter((file) => file.status !== "excluded");
  const included = eligible.filter((file) => file.inclusion !== "none").length;
  const partialFiles = eligible.filter(
    (file) => file.inclusion === "partial",
  ).length;
  const unavailable = eligible.filter(
    (file) => file.status === "unavailable",
  ).length;
  return `${input.coverage === "partial" ? "Partial review" : "Review input"}: ${included} of ${eligible.length} eligible files included in the AI review context; ${partialFiles} partially included, ${unavailable} unavailable. Inclusion does not guarantee analysis. Assess only supplied changes, never the entire PR when coverage is partial.`;
}

/** Persist coverage beside the response; do not publish a whole-PR grade for partial input. */
export function applyReviewInput(
  review: StructuredReview,
  input: ReviewInputMetadata,
) {
  if (
    !review ||
    typeof review.summary !== "string" || !review.summary.trim() ||
    !Number.isInteger(review.overall_score) ||
    review.overall_score < 1 || review.overall_score > 100 ||
    !REVIEW_RISKS.includes(review.risk_level) ||
    !Array.isArray(review.findings) ||
    review.findings.some(
      (finding) =>
        !finding ||
        [
          finding.file_path,
          finding.title,
          finding.description,
          finding.recommendation,
          finding.severity,
          finding.category,
        ].some((value) => typeof value !== "string" || !value.trim()) ||
        !REVIEW_SEVERITIES.includes(finding.severity) ||
        !REVIEW_CATEGORIES.includes(finding.category) ||
        (finding.line_number != null && !Number.isInteger(finding.line_number)) ||
        (finding.code_suggestion != null && typeof finding.code_suggestion !== "string"),
    )
  ) {
    throw new Error("REVIEW_OUTPUT_INCOMPLETE");
  }
  const included = new Map(
    input.files
      .filter((file) => file.inclusion !== "none")
      .map((file) => [file.filename, file]),
  );
  const findings = review.findings
    .filter((finding) => included.has(finding.file_path))
    .map((finding) => {
      const file = included.get(finding.file_path)!;
      const validLine =
        Number.isInteger(finding.line_number) &&
        file.hunks.some(
          (hunk) =>
            hunk.included &&
            hunk.newLines > 0 &&
            finding.line_number! >= hunk.newStart &&
            finding.line_number! < hunk.newStart + hunk.newLines,
        );
      return {
        ...finding,
        line_number: validLine ? finding.line_number! : null,
        code_suggestion: finding.code_suggestion?.trim() ? finding.code_suggestion : null,
      };
    });
  return {
    ...review,
    findings,
    summary:
      input.coverage === "partial"
        ? `${reviewCoverageMessage(input)}\n\n${review.summary}`
        : review.summary,
    overall_score: input.coverage === "partial" ? null : review.overall_score,
    risk_level: input.coverage === "partial" ? null : review.risk_level,
    head_sha: input.headSha,
    base_sha: input.baseSha,
    review_input: input,
  };
}
