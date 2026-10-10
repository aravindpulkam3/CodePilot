import { useState } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/utils/cn";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { PullRequestDetail } from "@/types/repositoryTypes";
import { Finding, Review, ReviewHistoryItem, SeverityKey, severityKey } from "@/types/reviewTypes";
import { basename } from "@/utils/reviewNavigation";
import { relativeTime } from "@/utils/relativeTime";
import { SeverityIcon } from "./SeverityIcon";

interface ReviewOverviewProps {
  pr: PullRequestDetail;
  latest: Review | null;
  history: ReviewHistoryItem[];
  isOutdated: boolean;
  isGenerating: boolean;
  generateError: string | null;
  onGenerate: () => void;
  activeFindingId: string | null;
  onSelectFinding: (finding: Finding) => void;
}

const GROUPS: { key: SeverityKey; label: string }[] = [
  { key: "critical", label: "Critical" },
  { key: "major", label: "Major" },
  { key: "minor", label: "Minor" },
  { key: "info", label: "Info" },
];

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline gap-2.5">
      <h2 className="font-sans text-xs font-semibold tracking-normal text-rv-ink">{children}</h2>
      {aside}
    </div>
  );
}

/**
 * The PR-level view, and where the page lands: verdict, summary, findings
 * by severity, the PR description and earlier runs. Typographic and
 * list-based on purpose — no cards, no stat tiles. Minor and Info findings
 * fold away so the list leads with what blocks the merge.
 */
export function ReviewOverview({
  pr,
  latest,
  history,
  isOutdated,
  isGenerating,
  generateError,
  onGenerate,
  activeFindingId,
  onSelectFinding,
}: ReviewOverviewProps) {
  const [showLowSeverity, setShowLowSeverity] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);

  const findings = latest?.findings ?? [];
  const bySeverity = (key: SeverityKey) => findings.filter((f) => severityKey(f.severity) === key);
  const lowCount = bySeverity("minor").length + bySeverity("info").length;
  const description = pr.description?.trim() ?? "";
  const longDescription = description.length > 500;

  return (
    <div className="thin-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto bg-rv-code">
      <div className="max-w-[800px] px-8 pb-12 pt-5">
        <section>
          <SectionTitle>Review</SectionTitle>
          {latest ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 text-xs text-rv-mute">
                <span className="text-[22px] font-semibold leading-7 tracking-tight text-rv-ink [font-variant-numeric:tabular-nums]">
                  {latest.overall_score}
                  <span className="text-[13px] font-normal tracking-normal text-rv-mute"> /100</span>
                </span>
                {latest.risk_level && (
                  <span className="text-[13px] text-rv-ink2">
                    {latest.risk_level.charAt(0).toUpperCase() + latest.risk_level.slice(1).toLowerCase()} risk
                  </span>
                )}
                <span>
                  Reviewed <span className="font-mono">{latest.head_sha.slice(0, 7)}</span> · {relativeTime(latest.created_at)}
                </span>
              </div>
              {isOutdated && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-rv-warn">
                  <Clock className="h-3.5 w-3.5" />
                  Outdated — the pull request has new commits since this review.
                </p>
              )}
            </>
          ) : isGenerating ? (
            <p className="text-[13px] text-rv-ink2">Reviewing… this usually takes 30–60 seconds.</p>
          ) : (
            <div className="text-[13px]">
              <p className="text-rv-ink">No review for this pull request yet.</p>
              <p className="mt-1 max-w-[68ch] text-rv-mute">
                A review reads the diff against the indexed repository and leaves findings on the lines they concern. It
                needs the repository to have finished indexing.
              </p>
              <button
                type="button"
                onClick={onGenerate}
                className="mt-3 inline-flex h-7 items-center rounded bg-signal-600 px-2.5 text-xs font-medium text-white hover:bg-signal-700"
              >
                Generate review
              </button>
            </div>
          )}
          {generateError && !isGenerating && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{generateError}</p>}
        </section>

        {latest?.summary && (
          <section className="mt-7">
            <SectionTitle>Summary</SectionTitle>
            <div className="max-w-[68ch]">
              <MarkdownRenderer content={latest.summary} tone="review" />
            </div>
          </section>
        )}

        {latest && (
          <section className="mt-7">
            <SectionTitle
              aside={
                <>
                  <span className="font-mono text-[11px] text-rv-mute">{findings.length}</span>
                  {findings.length > 0 && (
                    <span className="ml-auto flex items-center gap-3.5 font-mono text-[11px] text-rv-mute">
                      {GROUPS.map(({ key }) => {
                        const count = bySeverity(key).length;
                        return count > 0 ? (
                          <span key={key} className="flex items-center gap-1">
                            <SeverityIcon severity={key} />
                            {count}
                          </span>
                        ) : null;
                      })}
                    </span>
                  )}
                </>
              }
            >
              Findings
            </SectionTitle>
            {findings.length === 0 ? (
              <p className="text-[13px] text-rv-mute">Nothing was flagged in this review.</p>
            ) : (
              <>
                {GROUPS.filter(({ key }) => showLowSeverity || key === "critical" || key === "major").map(({ key, label }) => {
                  const group = bySeverity(key);
                  if (group.length === 0) return null;
                  return (
                    <div key={key}>
                      <div className="flex h-7 items-end border-b border-rv-hair pb-1 text-[11px] text-rv-mute">{label}</div>
                      {group.map((finding) => (
                        <button
                          key={finding.id}
                          type="button"
                          onClick={() => onSelectFinding(finding)}
                          className={cn(
                            "grid h-[30px] w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 border-b border-rv-hair pl-0.5 pr-1 text-left text-[13px] text-rv-ink",
                            finding.id === activeFindingId ? "bg-rv-sel" : "hover:bg-rv-hover",
                          )}
                        >
                          <SeverityIcon severity={finding.severity} />
                          <span className="truncate">{finding.title}</span>
                          <span className="whitespace-nowrap font-mono text-[11.5px] text-rv-mute">
                            {basename(finding.file_path)}
                            {finding.line_number !== null && `:${finding.line_number}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {lowCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowLowSeverity((v) => !v)}
                    className="flex h-8 w-full items-center border-b border-rv-hair text-left text-xs text-rv-ink2 hover:text-rv-ink"
                  >
                    {showLowSeverity ? "Hide minor and info findings" : `Show ${lowCount} minor and info ${lowCount === 1 ? "finding" : "findings"}`}
                  </button>
                )}
              </>
            )}
          </section>
        )}

        <section className="mt-7">
          <SectionTitle
            aside={
              <span className="ml-auto text-[11px] text-rv-mute">
                {pr.author?.login} · opened {relativeTime(pr.created_at)} · {pr.commits_count}{" "}
                {pr.commits_count === 1 ? "commit" : "commits"}
              </span>
            }
          >
            Description
          </SectionTitle>
          {description ? (
            <>
              <div className={cn("max-w-[68ch]", longDescription && !descriptionOpen && "max-h-32 overflow-hidden")}>
                <MarkdownRenderer content={description} tone="review" />
              </div>
              {longDescription && (
                <button type="button" onClick={() => setDescriptionOpen((v) => !v)} className="mt-1.5 text-xs text-rv-ink2 hover:text-rv-ink">
                  {descriptionOpen ? "Show less" : "Show more"}
                </button>
              )}
            </>
          ) : (
            <p className="text-[13px] text-rv-mute">No description.</p>
          )}
        </section>

        {history.length > 0 && (
          <section className="mt-7">
            <SectionTitle>Previous reviews</SectionTitle>
            {history.map((h) => (
              <div
                key={h.id}
                className="grid h-[30px] grid-cols-[36px_72px_minmax(0,1fr)] items-center gap-2 border-b border-rv-hair text-xs text-rv-mute"
              >
                <span className="font-mono text-rv-ink2">{h.overall_score}</span>
                <span>{new Date(h.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span className="truncate" title={h.summary}>
                  {h.summary}
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
