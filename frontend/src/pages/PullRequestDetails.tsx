// import React from "react";
import { useParams } from "react-router-dom";
import { usePullRequestDetail } from "@/hooks/useRepository";
import { useTriggerAiReview } from "@/hooks/useReview";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody,CardHeader } from "@/components/ui/Card";
export default function PullRequestDetailsPage() {
  const { repositoryId, pullNumber } = useParams<{ repositoryId: string; pullNumber: string }>();

  // 1. Data Fetching Hook (Fetches PR metadata and Git patches)
  const { 
    data: prDetails, 
    isLoading: prLoading 
  } = usePullRequestDetail(repositoryId!, pullNumber!);

  // 2. AI Review Mutation Hook
  const { 
    mutate: triggerReview, 
    data: review, 
    isPending 
  } = useTriggerAiReview();

  if (prLoading) return <div className="p-8 text-center text-lg font-medium">Loading Pull Request...</div>;
  if (!prDetails) return <div className="p-8 text-center text-red-500">Failed to load Pull Request details.</div>;

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      {/* --- PAGE HEADER --- */}
      <PageHeader 
        title={`#${pullNumber} ${prDetails.title || 'Pull Request'}`} 
        description={`Opened by ${prDetails.author?.login || 'Unknown'} • ${prDetails.changed_files_count || 0} files changed`}
      />

      {/* --- AI REVIEW TRIGGER BANNER --- */}
      <div className="my-8 flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-50 dark:bg-slate-800/50 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm gap-4">
        <div>
          <h2 className="text-xl font-bold mb-2">AI Code Review</h2>
          <p className="text-slate-600 dark:text-slate-400 max-w-2xl">
            Generate a deep, context-aware analysis of this pull request using Gemini 2.0 Flash. The AI will categorize findings by Correctness, Security, Performance, and Best Practices.
          </p>
        </div>
        
        <button 
          onClick={() => {
            if (repositoryId && pullNumber) {
               triggerReview({ repositoryId, pullNumber: Number(pullNumber) });
            }
          }}
          disabled={isPending}
          className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap flex-shrink-0 shadow-sm hover:shadow"
        >
          {isPending ? "Analyzing Code..." : "Review with AI"}
        </button>
      </div>

      {/* --- AI REVIEW RESULTS --- */}
      {review && (
        <div className="space-y-6 mb-12">
          {/* Summary Card */}
          <Card>
            <CardHeader className="bg-slate-100 dark:bg-slate-800/80">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-lg">Review Summary</h3>
                <span className={`px-4 py-1.5 rounded-full text-sm font-bold ${
                  review.overall_score >= 80 ? 'bg-green-100 text-green-800' : 
                  review.overall_score >= 60 ? 'bg-yellow-100 text-yellow-800' : 
                  'bg-red-100 text-red-800'
                }`}>
                  Score: {review.overall_score}/100
                </span>
              </div>
            </CardHeader>
            <CardBody>
              <p className="whitespace-pre-wrap leading-relaxed text-slate-700 dark:text-slate-300">
                {review.summary}
              </p>
            </CardBody>
          </Card>

          {/* Detailed Findings */}
          {review.findings && review.findings.length > 0 && (
            <>
              <h3 className="text-xl font-bold mt-10 mb-4">Detailed Findings</h3>
              <div className="grid gap-5">
                {review.findings.map((finding: any, idx: number) => (
                  <Card key={idx} className={`overflow-hidden ${
                    finding.severity === 'Critical' || finding.severity === 'High' ? 'border-l-4 border-l-red-500' : 
                    finding.severity === 'Major' || finding.severity === 'Medium' ? 'border-l-4 border-l-amber-500' : 
                    'border-l-4 border-l-blue-500'
                  }`}>
                    <CardBody>
                      <div className="flex flex-col md:flex-row md:justify-between md:items-center mb-3 gap-2">
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-bold px-2.5 py-1 rounded-md uppercase tracking-wider ${
                            finding.category === 'Security' ? 'bg-red-100 text-red-800' :
                            finding.category === 'Performance' ? 'bg-purple-100 text-purple-800' :
                            'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200'
                          }`}>
                            {finding.category}
                          </span>
                          <span className="font-bold text-lg">{finding.title}</span>
                        </div>
                        <span className="text-sm font-mono bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700">
                          {finding.file_path} {finding.line_number ? `(Line ${finding.line_number})` : ''}
                        </span>
                      </div>
                      
                      <p className="text-slate-700 dark:text-slate-300 mb-5">{finding.description}</p>
                      
                      <div className="bg-blue-50/50 dark:bg-blue-900/10 p-4 rounded-lg border border-blue-100 dark:border-blue-900/30">
                        <strong className="block mb-1.5 text-blue-900 dark:text-blue-300">Recommendation:</strong>
                        <span className="text-sm text-slate-800 dark:text-slate-200">{finding.recommendation}</span>
                      </div>

                      {finding.code_suggestion && (
                        <div className="mt-5">
                          <strong className="block mb-2 text-sm text-slate-600 dark:text-slate-400">Suggested Fix:</strong>
                          <pre className="p-4 bg-slate-950 text-green-400 rounded-lg overflow-x-auto text-sm font-mono shadow-inner">
                            <code>{finding.code_suggestion}</code>
                          </pre>
                        </div>
                      )}
                    </CardBody>
                  </Card>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* --- CODE DIFF VIEWER --- */}
      <div className="mt-12">
        <h3 className="text-xl font-bold mb-6 pb-2 border-b border-slate-200 dark:border-slate-700">
          Files Changed ({prDetails.files?.length || 0})
        </h3>
        
        <div className="space-y-6">
          {prDetails.files?.map((file: any, index: number) => (
            <div key={index} className="border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden bg-white dark:bg-slate-900 shadow-sm">
              {/* File Header */}
              <div className="flex justify-between items-center px-5 py-3 bg-slate-100 dark:bg-slate-800 border-b border-slate-300 dark:border-slate-700">
                <span className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {file.filename}
                </span>
                <div className="flex space-x-4 text-sm bg-white dark:bg-slate-900 px-3 py-1 rounded-md border border-slate-200 dark:border-slate-700">
                  <span className="text-green-600 dark:text-green-500 font-bold">+{file.additions}</span>
                  <span className="text-red-600 dark:text-red-500 font-bold">-{file.deletions}</span>
                </div>
              </div>

              {/* File Patch Render */}
              {file.patch ? (
                <div className="overflow-x-auto">
                  <pre className="text-sm font-mono whitespace-pre-wrap leading-relaxed">
                    {file.patch.split('\n').map((line: string, i: number) => {
                      // Determine GitHub-style diff colors
                      let lineClass = "text-slate-800 dark:text-slate-300";
                      let bgClass = "bg-transparent";

                      if (line.startsWith('+')) {
                        lineClass = "text-green-800 dark:text-green-300";
                        bgClass = "bg-green-100/50 dark:bg-green-900/30";
                      } else if (line.startsWith('-')) {
                        lineClass = "text-red-800 dark:text-red-300";
                        bgClass = "bg-red-100/50 dark:bg-red-900/30";
                      } else if (line.startsWith('@@')) {
                        lineClass = "text-blue-600 dark:text-blue-400 font-bold";
                        bgClass = "bg-blue-50/50 dark:bg-blue-900/20";
                      }

                      return (
                        <div key={i} className={`px-4 py-0.5 ${bgClass}`}>
                          <span className={lineClass}>{line}</span>
                        </div>
                      );
                    })}
                  </pre>
                </div>
              ) : (
                <div className="p-5 text-sm text-slate-500 italic">No patch available for this file (Binary or too large).</div>
              )}
            </div>
          ))}
        </div>
      </div>
      
    </div>
  );
}