import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ErrorState } from "@/components/ui/ErrorState";
import { usePullRequestDetail } from "@/hooks/useRepository";
import { useTriggerAiReview, usePullRequestReviews } from "@/hooks/useReview";
import { PullRequestBar } from "@/components/review/PullRequestBar";
import { ChangedFilesRail } from "@/components/review/ChangedFilesRail";
import { DiffViewer } from "@/components/review/DiffViewer";
import { ReviewAIPanel, ReviewAiPanelScope } from "@/components/review/ReviewAIPanel";
import { Finding, compareBySeverity, getFindingsForFile } from "@/types/reviewTypes";


export default function PullRequestDetails() {
  const { repositoryId, pullNumber } = useParams<{ repositoryId: string; pullNumber: string }>();

  const {
    data: pr,
    isLoading: isPrLoading,
    isError: isPrError,
    refetch: refetchPr,
  } = usePullRequestDetail(repositoryId!, pullNumber!);

  const {
    data: reviews,
    isLoading: isReviewsLoading,
    isError: isReviewsError,
    refetch: refetchReviews,
  } = usePullRequestReviews(repositoryId!, pullNumber!);

  const { mutate: generateReview, isPending: isGenerating } = useTriggerAiReview();

  const latest = reviews?.latest ?? null;
  const history = reviews?.history ?? [];
  const isOutdated = !!latest && !!pr && pr.head_sha !== latest.head_sha;

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiScope, setAiScope] = useState<ReviewAiPanelScope>({ type: "review" });

  // Default the selected file once files load: the file of the most
  // severe finding if any exist, otherwise the first changed file.
  useEffect(() => {
    if (selectedFile || !pr?.files?.length) return;
    if (latest?.findings?.length) {
      const sorted = [...latest.findings].sort(compareBySeverity);
      const match = pr.files.find(
        (f) => f.filename === sorted[0].file_path || f.previous_filename === sorted[0].file_path
      );
      if (match) {
        setSelectedFile(match.filename);
        return;
      }
    }
    setSelectedFile(pr.files[0].filename);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr, latest]);

  const currentFile = useMemo(
    () => pr?.files.find((f) => f.filename === selectedFile) ?? null,
    [pr, selectedFile]
  );

  const findingsForCurrentFile = useMemo(
    () => (currentFile && latest ? getFindingsForFile(latest.findings, currentFile) : []),
    [currentFile, latest]
  );

  const fileForFinding = useMemo(() => {
    if (aiScope.type !== "finding" || !pr) return null;
    return (
      pr.files.find(
        (f) => f.filename === aiScope.finding.file_path || f.previous_filename === aiScope.finding.file_path
      ) ?? null
    );
  }, [aiScope, pr]);

  const handleSelectFile = (filename: string) => {
    setSelectedFile(filename);
    setActiveFindingId(null);
  };

  const handleSelectFinding = (finding: Finding, filename: string | null) => {
    if (filename && filename !== selectedFile) setSelectedFile(filename);
    setActiveFindingId(finding.id);
  };

  const handleAskAi = (finding: Finding) => {
    setAiScope({ type: "finding", finding });
    setAiPanelOpen(true);
  };

  if (isPrLoading || isReviewsLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-light dark:text-muted-dark">Loading PR details...</div>;
  }
  if (isPrError || isReviewsError) {
    return (
      <div className="p-6">
        <ErrorState message="Couldn't load this pull request." onRetry={() => { refetchPr(); refetchReviews(); }} />
      </div>
    );
  }
  if (!pr) {
    return <div className="flex h-full items-center justify-center text-sm text-red-500">Pull Request not found.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PullRequestBar
        pr={pr}
        repositoryId={repositoryId!}
        latest={latest}
        history={history}
        isOutdated={isOutdated}
        onGenerateReview={() => generateReview({ repositoryId: repositoryId!, pullNumber: Number(pullNumber) })}
        isGenerating={isGenerating}
        aiPanelOpen={aiPanelOpen}
        onToggleAiPanel={() => setAiPanelOpen((v) => !v)}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <ChangedFilesRail
          files={pr.files}
          findings={latest?.findings ?? []}
          changedFilesCount={pr.changed_files_count}
          selectedFile={selectedFile}
          onSelectFile={handleSelectFile}
          onSelectFinding={handleSelectFinding}
          activeFindingId={activeFindingId}
        />

        {currentFile ? (
          <DiffViewer
            file={currentFile}
            findings={findingsForCurrentFile}
            activeFindingId={activeFindingId}
            onAskAi={handleAskAi}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-light dark:text-muted-dark">
            {pr.files.length === 0 ? "No changed files in this pull request." : "Select a file to view its diff."}
          </div>
        )}

        {aiPanelOpen && (
          <ReviewAIPanel
            repositoryId={repositoryId!}
            reviewId={latest?.id ?? null}
            scope={aiScope}
            onScopeChange={setAiScope}
            onClose={() => setAiPanelOpen(false)}
            fileForFinding={fileForFinding}
          />
        )}
      </div>
    </div>
  );
}
