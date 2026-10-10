import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import axios from "axios";
import { ErrorState } from "@/components/ui/ErrorState";
import { isGitHubNotConnected } from "@/utils/githubErrors";
import { usePullRequestDetail, useRepositoryDetails } from "@/hooks/useRepository";
import { useTriggerAiReview, usePullRequestReviews } from "@/hooks/useReview";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { useElementWidth } from "@/hooks/useElementWidth";
import { ReviewContextBar } from "@/components/review/ReviewContextBar";
import { ReviewNavigator, ReviewNavigatorStrip } from "@/components/review/ReviewNavigator";
import { ReviewOverview } from "@/components/review/ReviewOverview";
import { DiffViewer } from "@/components/review/DiffViewer";
import { FindingDiscussion } from "@/components/review/FindingDiscussion";
import { ChangedFile, Finding } from "@/types/reviewTypes";
import { findingMatchesFile, orderFindings, resolveLayout, stepThrough } from "@/utils/reviewNavigation";
import { reviewCoverageLabel, reviewRevisionState } from "@/utils/reviewCoverage";

const NAVIGATOR_PREF = "review-navigator-open";
const DISCUSSION_PREF = "review-discussion-open";
const EMPTY: never[] = [];

function readPref(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore (private browsing, etc.)
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="review-ws flex h-full items-center justify-center bg-rv-code text-[13px] text-rv-mute">{children}</div>
  );
}

/**
 * The PR review workspace. Where you are lives in the URL (`?file=` and
 * `?finding=`, written with replace so Back still leaves for the PR list):
 * no file means the Overview. The navigator is the one place to go
 * somewhere; the discussion follows the selected finding but is never
 * dropped by merely opening a file. What is docked is decided by
 * resolveLayout so the code always keeps ~80 characters.
 */
export default function PullRequestDetails() {
  const { repositoryId, pullNumber } = useParams<{ repositoryId: string; pullNumber: string }>();

  const { data: pr, isLoading: isPrLoading, isError: isPrError, error: prError, refetch: refetchPr } = usePullRequestDetail(
    repositoryId!,
    pullNumber!,
  );
  const { data: reviews, isLoading: isReviewsLoading, isError: isReviewsError, refetch: refetchReviews } =
    usePullRequestReviews(repositoryId!, pullNumber!);
  const { data: repo } = useRepositoryDetails(repositoryId!);
  const { mutate: generateReview, isPending: isGenerating, error: generateError } = useTriggerAiReview();

  const [searchParams, setSearchParams] = useSearchParams();
  const [navigatorOpen, setNavigatorOpen] = useState(() => readPref(NAVIGATOR_PREF, true));
  const [navigatorPeek, setNavigatorPeek] = useState(false);
  const [discussionOpen, setDiscussionOpen] = useState(() => readPref(DISCUSSION_PREF, false));
  const [discussionFindingId, setDiscussionFindingId] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const { ref: workspaceRef, width: measuredWidth } = useElementWidth<HTMLDivElement>();
  const { width: discussionWidth, handleProps: discussionResizeProps } = useResizableWidth({
    storageKey: "review-discussion-width",
    defaultWidth: 360,
    minWidth: 320,
    maxWidth: 560,
  });

  const latest = reviews?.latest ?? null;
  const history = reviews?.history ?? EMPTY;
  const findings: Finding[] = latest?.findings ?? EMPTY;
  const files: ChangedFile[] = pr?.files ?? EMPTY;
  const revisionState = reviewRevisionState(latest, pr);
  const isOutdated = revisionState === "outdated";
  const canAnchorFindings = revisionState === "current";
  const ordered = useMemo(() => orderFindings(files, findings), [files, findings]);

  const fileParam = searchParams.get("file");
  const currentFile = (fileParam && files.find((f) => f.filename === fileParam)) || null;
  const activeFinding = findings.find((f) => f.id === searchParams.get("finding")) ?? null;
  const activeFindingId = activeFinding?.id ?? null;
  const discussionFinding = findings.find((f) => f.id === discussionFindingId) ?? null;

  // Until the workspace is measured, assume room for everything.
  const workspaceWidth = measuredWidth || Number.POSITIVE_INFINITY;
  const layout = resolveLayout(workspaceWidth, { navigatorOpen, discussionOpen, discussionWidth });
  const navigatorFits =
    resolveLayout(workspaceWidth, { navigatorOpen: true, discussionOpen, discussionWidth }).navigator === "docked";

  const select = useCallback(
    (file: string | null, findingId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (file) next.set("file", file);
          else next.delete("file");
          if (findingId) next.set("finding", findingId);
          else next.delete("finding");
          return next;
        },
        { replace: true },
      );
      setNavigatorPeek(false);
    },
    [setSearchParams],
  );

  const fileOf = (finding: Finding) => ordered.find((o) => o.finding.id === finding.id)?.filename ?? null;

  const selectFinding = (finding: Finding, filename: string | null = fileOf(finding)) => {
    if (!canAnchorFindings) {
      select(null, finding.id);
      setDiscussionFindingId(finding.id);
      setDiscussionOpen(true);
      return;
    }
    select(filename, finding.id);
    if (discussionOpen) setDiscussionFindingId(finding.id);
  };

  const openDiscussion = (findingId: string | null) => {
    setDiscussionFindingId(findingId);
    setDiscussionOpen(true);
    writePref(DISCUSSION_PREF, true);
  };
  const closeDiscussion = () => {
    setDiscussionOpen(false);
    writePref(DISCUSSION_PREF, false);
  };
  const toggleDiscussion = () => (discussionOpen ? closeDiscussion() : openDiscussion(activeFindingId ?? discussionFindingId));

  const setNavigator = (open: boolean) => {
    setNavigatorOpen(open);
    writePref(NAVIGATOR_PREF, open);
    setNavigatorPeek(false);
  };
  const expandNavigator = () => (navigatorFits ? setNavigator(true) : setNavigatorPeek(true));

  const fileIndex = currentFile ? files.indexOf(currentFile) : -1;
  const stepFile = (delta: 1 | -1) => {
    const next = stepThrough(files, fileIndex, delta);
    if (next) select(next.filename, null);
  };
  const stepFinding = (delta: 1 | -1) => {
    let index = ordered.findIndex((o) => o.finding.id === activeFindingId);
    if (index < 0 && currentFile) {
      // From a file with nothing selected, start inside that file.
      const inFile = ordered.filter((o) => o.filename === currentFile.filename);
      const start = delta === 1 ? inFile[0] : inFile[inFile.length - 1];
      if (start) return selectFinding(start.finding, start.filename);
    }
    const next = stepThrough(ordered, index, delta);
    if (next) selectFinding(next.finding, next.filename);
  };

  // Keyboard map; re-bound each render so handlers never see stale state.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
      switch (e.key) {
        case "j":
          stepFinding(1);
          break;
        case "k":
          stepFinding(-1);
          break;
        case "]":
          stepFile(1);
          break;
        case "[":
          stepFile(-1);
          break;
        case "o":
          select(null, null);
          break;
        case "d":
          toggleDiscussion();
          break;
        case "/":
          e.preventDefault();
          if (layout.navigator !== "docked") setNavigatorPeek(true);
          setTimeout(() => filterInputRef.current?.focus(), 0);
          break;
        case "Escape":
          if (navigatorPeek) setNavigatorPeek(false);
          else if (discussionOpen) closeDiscussion();
          else if (activeFindingId) select(currentFile?.filename ?? null, null);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (isPrLoading || isReviewsLoading) return <Centered>Loading pull request…</Centered>;
  if (isGitHubNotConnected(prError)) return <Centered>Connect your GitHub account to view this pull request.</Centered>;
  if (isPrError || isReviewsError) {
    return (
      <div className="p-6">
        <ErrorState
          message="Couldn't load this pull request."
          onRetry={() => {
            refetchPr();
            refetchReviews();
          }}
        />
      </div>
    );
  }
  if (!pr) return <Centered>Pull request not found.</Centered>;

  const generateErrorMessage = generateError
    ? (axios.isAxiosError(generateError) && generateError.response?.data?.error) || generateError.message
    : null;
  const navigatorProps = {
    files,
    findings,
    changedFilesCount: pr.changed_files_count,
    view: currentFile ? ("file" as const) : ("overview" as const),
    selectedFile: currentFile?.filename ?? null,
    activeFindingId,
    reviewScore: latest?.overall_score ?? null,
    onSelectOverview: () => select(null, null),
    onSelectFile: (filename: string) => select(filename, null),
    onSelectFinding: (finding: Finding, filename: string | null) => selectFinding(finding, filename),
    onCollapse: () => setNavigator(false),
    filterInputRef,
  };
  const currentFindings = currentFile && canAnchorFindings ? ordered.filter((o) => o.filename === currentFile.filename).map((o) => o.finding) : [];

  return (
    <div className="review-ws flex h-full min-h-0 flex-col bg-rv-code font-sans text-rv-ink">
      <ReviewContextBar
        pr={pr}
        repositoryId={repositoryId!}
        repoName={repo?.name ?? null}
        latest={latest}
        isOutdated={isOutdated}
        isGenerating={isGenerating}
        onGenerate={() => generateReview({ repositoryId: repositoryId!, pullNumber: Number(pullNumber) })}
        discussionOpen={discussionOpen}
        onToggleDiscussion={toggleDiscussion}
        compact={workspaceWidth < 1150}
      />

      {latest?.review_input && (
        <div className="border-b border-rv-hair px-4 py-2 text-xs text-rv-mute">
          <span className={latest.review_input.coverage === "partial" ? "text-rv-warn" : undefined}>
            {reviewCoverageLabel(latest.review_input)}
          </span>{" "}Inclusion does not guarantee analysis. Findings apply only to supplied changes.
        </div>
      )}
      {latest && !canAnchorFindings && (
        <div className="border-b border-rv-hair px-4 py-2 text-xs text-rv-warn">
          {isOutdated ? "This review describes an earlier PR revision." : "This older review has no recorded base revision; input coverage is unknown."}
          {" "}Findings are available in the overview; inline anchors and current-diff attachments are disabled.
        </div>
      )}
      <div ref={workspaceRef} className="relative flex min-h-0 flex-1">
        {layout.navigator === "docked" ? (
          <ReviewNavigator {...navigatorProps} />
        ) : (
          <ReviewNavigatorStrip findings={findings} onExpand={expandNavigator} onOverview={() => select(null, null)} />
        )}
        {navigatorPeek && layout.navigator === "strip" && (
          <>
            <div className="absolute inset-0 z-20" onClick={() => setNavigatorPeek(false)} aria-hidden="true" />
            <ReviewNavigator {...navigatorProps} onCollapse={() => setNavigatorPeek(false)} className="absolute inset-y-0 left-10 z-30 shadow-panel" />
          </>
        )}

        {currentFile ? (
          <DiffViewer
            key={currentFile.filename}
            file={currentFile}
            findings={currentFindings}
            activeFindingId={activeFindingId}
            discussionFindingId={discussionOpen ? discussionFinding?.id ?? null : null}
            onSelectFinding={(finding) => selectFinding(finding, currentFile.filename)}
            onDiscuss={(finding) => {
              select(currentFile.filename, finding.id);
              openDiscussion(finding.id);
            }}
            fileIndex={fileIndex}
            fileCount={files.length}
            onStepFile={stepFile}
            githubFilesUrl={repo?.html_url ? `${repo.html_url}/pull/${pr.number}/files` : null}
            compact={workspaceWidth < 1000}
          />
        ) : (
          <ReviewOverview
            pr={pr}
            latest={latest}
            history={history}
            isOutdated={isOutdated}
            isGenerating={isGenerating}
            generateError={generateErrorMessage}
            onGenerate={() => generateReview({ repositoryId: repositoryId!, pullNumber: Number(pullNumber) })}
            activeFindingId={activeFindingId}
            onSelectFinding={(finding) => selectFinding(finding)}
          />
        )}

        {layout.discussion !== "closed" && (
          <FindingDiscussion
            key={discussionFinding?.id ?? "review"}
            repositoryId={repositoryId!}
            reviewId={latest?.id ?? null}
            finding={discussionFinding}
            file={discussionFinding && canAnchorFindings ? files.find((f) => findingMatchesFile(discussionFinding.file_path, f)) ?? null : null}
            mode={layout.discussion}
            width={discussionWidth}
            resizeHandleProps={discussionResizeProps}
            onClose={closeDiscussion}
            onWholePr={() => setDiscussionFindingId(null)}
            onJumpToFinding={(finding) => selectFinding(finding)}
          />
        )}
      </div>
    </div>
  );
}
