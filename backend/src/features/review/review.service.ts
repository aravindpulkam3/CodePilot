import { safeErrorDetails } from "../../shared/utils/safeErrorDetails.js";
import { observe, type DiagnosticObserver } from "../../shared/utils/diagnostics.js";
import { pool } from "../../config/db.js";
import type { PoolClient } from "pg";
import {
  findRepositoryById,
  RepositoryRow,
} from "../repository/repository.service.js";
import * as githubService from "../../infrastructure/github/github.service.js";
import type { PullRequestFile } from "../../infrastructure/github/pullRequestSnapshot.js";
import {
  LLMService,
  LLMMessage,
  llmService,
} from "../../infrastructure/llm/llm.service.js";
import { CodeReviewPromptBuilder } from "./codeReviewPromptBuilder.js";
import { retrievalService } from "../../infrastructure/retrieval/retreival.service.js";
import type { RetrievedContext } from "../../infrastructure/retrieval/retrievalTypes.js";
import { documentationChunker } from "../../infrastructure/chunking/documentationChunking.service.js";
import { isDocumentationFile } from "../../shared/utils/documentationPaths.js";
import { verifyReviewEvidence } from "./reviewEvidence.js";
import { applyReviewInput, type ReviewInputMetadata } from "./reviewInput.js";
import type { LLMRequestBudget } from "../../infrastructure/llm/requestBudget.js";
import { buildDocumentationQuery } from "../../shared/utils/documentationQuery.js";
import { appEvents, EVENT_TYPES } from "../../shared/events/eventEmitter.js";
import { withCache, invalidateCacheKeys } from "../../shared/utils/cache.js";
import { stripChunkHeader } from "../../shared/prompts/sourceRefs.js";
import { astChunker } from "../../infrastructure/chunking/astChunking.service.js";
import {
  buildChangedCodeContext,
  type ChangedCodeContext,
  type ChangedCodeDeps,
} from "./changedCodeContext.js";
export interface StructuredReview {
  summary: string;
  overall_score: number;
  risk_level: string;
  findings: Array<{
    severity: string;
    category: string;
    file_path: string;
    line_number?: number | null;
    title: string;
    description: string;
    recommendation: string;
    code_suggestion?: string | null;
  }>;
}

/** The subset of GitHub PR data prompt assembly actually reads. */
export interface ReviewPrInput {
  title: string;
  description: string | null;
  /** PR head commit. The patches' + line numbers refer to this revision. */
  head_sha?: string | null;
  base_sha?: string | null;
  changed_files_count?: number;
  files: PullRequestFile[];
}

/** The subset of the repository row prompt assembly actually reads. */
export type ReviewRepoInput = Pick<
  RepositoryRow,
  "owner" | "name" | "default_branch" | "last_indexed_sha"
>;

/** Real I/O for changedCodeContext: GitHub content at a ref + the index's own AST chunker. */
export function githubChangedCodeDeps(
  owner: string,
  repo: string,
  token?: string,
): ChangedCodeDeps {
  return {
    fetchContent: (path, ref) =>
      githubService.fetchRawFileContent(token, owner, repo, path, ref),
    chunkFile: (path, content) => astChunker.chunkFile(path, content),
    supportsFile: (path) => astChunker.supportsFile(path),
  };
}

export class ReviewService {
  constructor(private llm: LLMService = llmService) {}

  /**
   * Retrieval + prompt assembly for one review, with no LLM call and no
   * database writes. Split out of generateAndStoreReview so the exact prompt
   * a review would send can be inspected on its own (scripts/evalRetrieval.ts).
   */
  async buildReviewMessages(
    clerkUserId: string,
    repositoryId: string,
    repoDetails: ReviewRepoInput,
    prDetails: ReviewPrInput,
    extra?: {
      skipSync?: boolean;
      githubToken?: string;
      budget?: LLMRequestBudget;
      onDiagnostic?: DiagnosticObserver;
    },
  ): Promise<{
    messages: LLMMessage[];
    retrievedContext: RetrievedContext;
    changedCode: ChangedCodeContext | null;
    reviewInput: ReviewInputMetadata;
  }> {
    if (!prDetails.head_sha || !prDetails.base_sha)
      throw new Error("PR_REVISION_UNAVAILABLE");
    const budget = extra?.budget ?? (await this.llm.getReviewBudget());
    const deps = githubChangedCodeDeps(
      repoDetails.owner,
      repoDetails.name,
      extra?.githubToken,
    );
    const fetched = new Map<string, Promise<string | null>>();
    const fetchContent = deps.fetchContent;
    deps.fetchContent = (path, ref) => {
      const key = ref + ":" + path;
      if (!fetched.has(key)) fetched.set(key, fetchContent(path, ref));
      return fetched.get(key)!;
    };
    const reviewableFiles = prDetails.files.filter((file) =>
      CodeReviewPromptBuilder.isReviewableFile(file.filename),
    );
    const changedCode = await buildChangedCodeContext(
      { headSha: prDetails.head_sha, files: reviewableFiles },
      deps,
    );
    const changedFilePaths = reviewableFiles.flatMap((file) =>
      file.previous_filename
        ? [file.filename, file.previous_filename]
        : [file.filename],
    );
    const ragQuery = `Pull Request Title: ${prDetails.title}. Description: ${prDetails.description || "None"}. Files modified: ${changedFilePaths.join(", ")}`;
    const candidates = await retrievalService.retrieveReviewContext(
      clerkUserId,
      repositoryId,
      ragQuery,
      changedFilePaths,
      undefined,
      buildDocumentationQuery(
        prDetails.title,
        prDetails.description,
        changedFilePaths,
      ),
      { skipSync: extra?.skipSync, onDiagnostic: extra?.onDiagnostic },
    );
    observe(extra?.onDiagnostic, "selected", candidates);
    // Retrieval may overlap an index update. Its output is discovery only:
    // neither indexed bodies, old line numbers, profiles nor claimed edges
    // are passed as factual evidence. All source below is reparsed at HEAD.
    const verified = await verifyReviewEvidence(
      candidates,
      prDetails.head_sha,
      {
        ...deps,
        chunkDocument: (path, source) =>
          isDocumentationFile(path)
            ? documentationChunker.chunkDocument(path, source)
            : documentationChunker.chunkWholeFile(path, source),
      },
    );
    const retrievedContext = verified.context;
    observe(extra?.onDiagnostic, "verified", { ...retrievedContext, excluded: verified.excluded });
    const codeContext = retrievedContext.codeChunks.map(
      (chunk) =>
        `// File: ${chunk.filePath}\n// Symbol: ${chunk.symbolName}\n// Lines: ${chunk.lineStart}-${chunk.lineEnd}\n// Candidate discovery: ${chunk.symbolType}\n${stripChunkHeader(chunk.content)}`,
    );
    const documentation = retrievedContext.docChunks.map(
      (chunk) =>
        `// File: ${chunk.filePath}\n// Lines: ${chunk.lineStart}-${chunk.lineEnd}\n${stripChunkHeader(chunk.content)}`,
    );
    const result = CodeReviewPromptBuilder.buildBudgetedReviewPrompt({
      repoName: repoDetails.name,
      title: prDetails.title,
      description: prDetails.description || "",
      headSha: prDetails.head_sha,
      baseSha: prDetails.base_sha,
      files: prDetails.files,
      expectedFiles: prDetails.changed_files_count ?? prDetails.files.length,
      budget,
      codeContext,
      documentation,
      changedCode,
      excludedEvidence: verified.excluded,
    });
    if (extra?.onDiagnostic) observe(extra.onDiagnostic, "prompt", {
      codeChunks: result.selection.codeIndices.map((i) => ({ ...retrievedContext.codeChunks[i], content: stripChunkHeader(retrievedContext.codeChunks[i].content) })),
      docChunks: result.selection.documentIndices.map((i) => ({ ...retrievedContext.docChunks[i], content: stripChunkHeader(retrievedContext.docChunks[i].content) })),
      enclosing: result.selection.enclosing,
      files: result.selection.files,
    });
    return { ...result, retrievedContext, changedCode };
  }

  /** Shared acquisition through validation/revision check. No publication writes.
   * Callers enforce repository ownership (HTTP controller or local evaluation CLI).
   */
  async generateReview(
    clerkUserId: string,
    repositoryId: string,
    pullNumber: number,
    options: {
      skipSync?: boolean;
      onDiagnostic?: DiagnosticObserver;
      expectedRevision?: { headSha: string; baseSha: string };
      checkSnapshot?: (snapshot: ReviewPrInput) => void;
      onAcquired?: () => void;
    } = {},
  ) {
    const started = performance.now();
    const repoDetails = await findRepositoryById(repositoryId);
    if (!repoDetails) throw new Error("REPO_NOT_FOUND");
    const prDetails = await githubService.getPullRequestDetails(clerkUserId, repositoryId, pullNumber, repoDetails);
    const headSha = prDetails.head_sha;
    observe(options.onDiagnostic, "snapshot", prDetails);
    const expected = options.expectedRevision;
    if (expected && (headSha !== expected.headSha || prDetails.base_sha !== expected.baseSha)) {
      throw new Error("EVAL_PR_REVISION_DRIFT");
    }
    options.checkSnapshot?.(prDetails);
    options.onAcquired?.();
    const acquired = performance.now();
    const githubToken = await githubService.getGitHubAccessToken(clerkUserId).catch(() => undefined);
    const { messages, reviewInput } = await this.buildReviewMessages(
      clerkUserId, repositoryId, repoDetails, prDetails,
      { githubToken, skipSync: options.skipSync, onDiagnostic: options.onDiagnostic },
    );
    const schema = CodeReviewPromptBuilder.getReviewSchema();
    observe(options.onDiagnostic, "request", { messages, schema, reviewInput, model: this.llm.modelName });
    const prepared = performance.now();
    let generated = prepared;
    let rawReview: StructuredReview;
    try {
      rawReview = await this.llm.generateStructured<StructuredReview>(messages, schema, reviewInput.budget, options.onDiagnostic);
    } finally {
      generated = performance.now();
      observe(options.onDiagnostic, "timing", { acquisitionMs: acquired - started,
        preparationMs: prepared - acquired, generationMs: generated - prepared });
    }
    observe(options.onDiagnostic, "rawReview", rawReview);
    const aiReview = applyReviewInput(rawReview, reviewInput);
    observe(options.onDiagnostic, "validated", aiReview);
    // Remains outside publication's transaction, as before.
    const currentRevision = await githubService.getPullRequestRevision(clerkUserId, repoDetails, pullNumber);
    const isLatest = currentRevision.head_sha === headSha && currentRevision.base_sha === reviewInput.baseSha;
    observe(options.onDiagnostic, "revision", currentRevision);
    if (expected && !isLatest) throw new Error("EVAL_PR_REVISION_DRIFT");
    observe(options.onDiagnostic, "completion", { totalMs: performance.now() - started,
      validationAndRevisionMs: performance.now() - generated });
    return { repoDetails, headSha, reviewInput, aiReview, isLatest };
  }

  async generateAndStoreReview(
    clerkUserId: string,
    repositoryId: string,
    pullNumber: number,
  ) {
    let client: PoolClient | undefined;

    try {
      const { repoDetails, headSha, aiReview, isLatest } = await this.generateReview(
        clerkUserId, repositoryId, pullNumber, {
          onAcquired: () => appEvents.emit(EVENT_TYPES.PR_UPDATED, { repositoryId, pullNumber }),
        },
      );

      // 5. Database Transaction
      client = await pool.connect();
      await client.query("BEGIN");

      // Serialize short publications across this repository, including first reviews.
      // Same-revision regenerations deliberately use last successful publication wins.
      const locked = await client.query("SELECT id FROM repositories WHERE id = $1 FOR UPDATE", [repositoryId]);
      if (!locked.rows.length) throw new Error("REPO_NOT_FOUND");

      // A. Demote older reviews
      if (isLatest) await client.query(
        `
        UPDATE reviews SET is_latest = FALSE
        WHERE repository_id = $1 AND pull_number = $2;
      `,
        [repositoryId, pullNumber],
      );

      // B. Insert the new Review record
      const reviewRes = await client.query(
        `
        INSERT INTO reviews
        (repository_id, pull_number, head_sha, model, summary, overall_score, risk_level, raw_response, is_latest)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id;
      `,
        [
          repositoryId,
          pullNumber,
          headSha,
          this.llm.modelName,
          aiReview.summary,
          aiReview.overall_score,
          aiReview.risk_level,
          JSON.stringify(aiReview),
          isLatest,
        ],
      );
      const newReviewId = reviewRes.rows[0].id;

      // C. Insert Findings
      if (aiReview.findings && aiReview.findings.length > 0) {
        const findingQueries = aiReview.findings.map((finding) => {
          return client!.query(
            `
            INSERT INTO review_findings
            (review_id, severity, category, file_path, line_number, title, description, recommendation, code_suggestion)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
          `,
            [
              newReviewId,
              finding.severity,
              finding.category,
              finding.file_path,
              finding.line_number,
              finding.title,
              finding.description,
              finding.recommendation,
              finding.code_suggestion,
            ],
          );
        });
        await Promise.all(findingQueries);
      }

      await client.query("COMMIT");
      client.release();
      client = undefined;

      // Persisted successfully — safe to invalidate dashboard caches that
      // could otherwise keep serving pending-review/activity state from
      // before this review existed.
      appEvents.emit(EVENT_TYPES.PR_REVIEW_COMPLETED, {
        userId: repoDetails.user_id,
        repositoryId,
        pullNumber,
      });

      await invalidateCacheKeys([
        `repo:${repositoryId}:pr:${pullNumber}:reviews`,
        `repo:${repositoryId}:pr:${pullNumber}:details`,
      ]);
      return { reviewId: newReviewId, ...aiReview };
    } catch (error) {
      console.error("AI Review Generation Failed:", {
        repositoryId,
        pullNumber,
        ...safeErrorDetails(error),
      });
      try {
        await client?.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Review rollback failed:", {
          repositoryId,
          pullNumber,
          ...safeErrorDetails(rollbackError),
        });
      }
      // Preserve readiness and upstream errors for the controller's existing handling.
      throw error;
    } finally {
      client?.release();
    }
  }
}

export const reviewService = new ReviewService();

export const getReviewsForPullRequest = async (
  repositoryId: string,
  pullNumber: number,
) => {
  // Mutable latest/history lists are read directly: a read begun before a
  // commit must not repopulate Redis with an old list after invalidation.
  const { rows: reviews } = await pool.query(
    `SELECT * FROM reviews
       WHERE repository_id = $1 AND pull_number = $2
       ORDER BY created_at DESC`,
    [repositoryId, pullNumber],
  );

  if (reviews.length === 0) {
    return { latest: null, history: [] };
  }

  const latest = reviews.find((r) => r.is_latest);
  if (!latest) return { latest: null, history: reviews };
  const history = reviews.filter((r) => r.id !== latest.id);

  // Runs on every call, cache hit or miss — this drives the dashboard's
  // "recent work" ordering, so a cache hit must not silently stop counting
  // a viewer's visit as engagement.
  await pool.query(
    `UPDATE reviews SET last_accessed_at = NOW() WHERE id = $1`,
    [latest.id],
  );

  // Same-head reruns have different findings. Cache by immutable review identity.
  const findings = await withCache(
    `repo:${repositoryId}:pr:${pullNumber}:review:${latest.id}:findings`,
    3600,
    async () => {
      const { rows } = await pool.query(
        `SELECT * FROM review_findings WHERE review_id = $1 ORDER BY file_path, line_number`,
        [latest.id],
      );
      return rows;
    },
  );

  return {
    latest: {
      ...latest,
      base_sha: latest.raw_response?.review_input?.baseSha ?? null,
      review_input: latest.raw_response?.review_input ?? null,
      findings,
    },
    history,
  };
};
