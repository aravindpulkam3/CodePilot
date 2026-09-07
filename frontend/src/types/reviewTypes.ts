// Single source of truth for PR review data shapes. Consolidates types that
// were previously duplicated (and in places wrong) across FindingCard.tsx,
// useReview.ts, and repositoryTypes.ts — see review data model investigation
// notes in the PR Review redesign plan.

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
  overall_score: number;
  risk_level: string | null;
  summary: string;
  head_sha: string;
  created_at: string;
  findings: Finding[];
}

export interface ReviewHistoryItem {
  id: string;
  summary: string;
  overall_score: number;
  created_at: string;
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

export interface SeverityStyle {
  label: string;
  dot: string; // background color class for a small severity dot
  text: string; // text color class
  tint: string; // subtle background tint for inline annotation blocks
  border: string; // left-accent border color
}

export const severityStyles: Record<string, SeverityStyle> = {
  critical: {
    label: "Critical",
    dot: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
    tint: "bg-rose-50 dark:bg-rose-500/10",
    border: "border-rose-500",
  },
  major: {
    label: "Major",
    dot: "bg-amber-400",
    text: "text-amber-600 dark:text-amber-400",
    tint: "bg-amber-50 dark:bg-amber-500/10",
    border: "border-amber-400",
  },
  warning: {
    label: "Major",
    dot: "bg-amber-400",
    text: "text-amber-600 dark:text-amber-400",
    tint: "bg-amber-50 dark:bg-amber-500/10",
    border: "border-amber-400",
  },
  minor: {
    label: "Minor",
    dot: "bg-blue-400",
    text: "text-blue-600 dark:text-blue-400",
    tint: "bg-blue-50 dark:bg-blue-500/10",
    border: "border-blue-400",
  },
  info: {
    label: "Info",
    dot: "bg-signal-500",
    text: "text-signal-600 dark:text-signal-400",
    tint: "bg-signal-50 dark:bg-signal-500/10",
    border: "border-signal-500",
  },
};

export function getSeverityStyle(severity: string | null | undefined): SeverityStyle {
  const key = (severity || "info").toLowerCase();
  return severityStyles[key] || severityStyles.info;
}

/**
 * Matches findings to one changed file — by `filename` first, then
 * `previous_filename` (renames), so a finding the model attributed to a
 * file's pre-rename path still resolves. Shared by ChangedFilesRail and
 * the DiffViewer wiring in PullRequestDetails.tsx so both use identical
 * matching.
 */
export function getFindingsForFile(findings: Finding[], file: ChangedFile): Finding[] {
  return findings.filter(
    (f) => f.file_path === file.filename || (!!file.previous_filename && f.file_path === file.previous_filename)
  );
}
