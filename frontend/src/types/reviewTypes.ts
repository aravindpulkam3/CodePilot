// Single source of truth for PR review data shapes. Consolidates types that
// were previously duplicated (and in places wrong) across FindingCard.tsx,
// useReview.ts, and repositoryTypes.ts — see review data model investigation
// notes in the PR Review redesign plan.

import { findingMatchesFile } from "@/utils/reviewNavigation";

export type Severity = "Critical" | "Major" | "Minor" | "Info";

export interface Finding {
  id: string;
  review_id?: string;
  severity: string; // free-text from the LLM; intended Info|Minor|Major|Critical, not DB-constrained
  category: string; // free-text from the LLM
  file_path: string; // never validated against the PR's changed files
  line_number: number | null; // single, nullable, unvalidated LLM guess — no range, no diff side
  title: string;
  description: string;
  recommendation: string;
  code_suggestion: string | null;
}

export interface Review {
  id: string;
  overall_score: number | null;
  risk_level: string | null;
  summary: string;
  head_sha: string;
  base_sha?: string | null;
  review_input?: ReviewInputMetadata | null;
  created_at: string;
  findings: Finding[];
}

export interface ReviewHistoryItem {
  id: string;
  summary: string;
  overall_score: number | null;
  created_at: string;
}

export interface ReviewInputMetadata {
  version: 1;
  headSha: string;
  baseSha: string;
  acquisition: { complete: boolean; expectedFiles: number; fetchedFiles: number };
  coverage: "complete" | "partial";
  files: Array<{
    filename: string;
    status: "available" | "excluded" | "unavailable";
    inclusion: "full" | "partial" | "none";
    reason?: string;
    hunks: Array<{ header: string; included: boolean }>;
    enclosing?: {
      status: "complete" | "partial" | "unavailable" | "not-applicable";
      uncovered: string[];
      reason?: string;
      split: boolean;
    };
  }>;
  excludedEvidence: Array<{ filename: string; reason: string }>;
}

export interface PullRequestReviews {
  latest: Review | null;
  history: ReviewHistoryItem[];
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: string; // "added" | "modified" | "removed" | "renamed" | ...
  additions: number;
  deletions: number;
  patch: string; // raw unified diff; "" for binary/huge files
}

// Critical > Major > Minor > Info; unrecognized severities sort last.
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  warning: 1, // FindingCard historically treated "warning" as major
  minor: 2,
  info: 3,
};

export function severityRank(severity: string | null | undefined): number {
  const key = (severity || "info").toLowerCase();
  return SEVERITY_ORDER[key] ?? 4;
}

export function compareBySeverity(a: Finding, b: Finding): number {
  return severityRank(a.severity) - severityRank(b.severity);
}

export type SeverityKey = "critical" | "major" | "minor" | "info";

const SEVERITY_KEYS: Record<string, SeverityKey> = {
  critical: "critical",
  major: "major",
  warning: "major",
  minor: "minor",
  info: "info",
};

const SEVERITY_LABELS: Record<SeverityKey, string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
  info: "Info",
};

/** Normalizes the model's free-text severity; anything unrecognized reads as Info. */
export function severityKey(severity: string | null | undefined): SeverityKey {
  return SEVERITY_KEYS[(severity || "info").toLowerCase()] ?? "info";
}

export function severityLabel(severity: string | null | undefined): string {
  return SEVERITY_LABELS[severityKey(severity)];
}

/**
 * Matches findings to one changed file — by `filename` first, then
 * `previous_filename` (renames), so a finding the model attributed to a
 * file's pre-rename path still resolves. The navigator, the diff and the
 * finding order all go through this one predicate.
 */
export function getFindingsForFile(findings: Finding[], file: ChangedFile): Finding[] {
  return findings.filter((f) => findingMatchesFile(f.file_path, file));
}
