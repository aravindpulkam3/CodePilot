import { pool } from "../config/db.js";
import { findRepositoryById } from "./repository.service.js";
import * as githubService from "./github.service.js";
import { llmService, LLMService, ollamaService } from "./llm.service.js";
import { CodeReviewPromptBuilder } from "../promptBuilders/codeReviewPromptBuilder.js";
import { retrievalService } from "./retreival.service.js";
import { repositorySyncService } from "./repositorySync.service.js";
import { isDocumentationFile } from "../utils/documentationPaths.js";
// TEMPORARY verification logging — see utils/readmeDebugLog.ts for removal.
import { docRetrievalLog } from "../utils/readmeDebugLog.js";
export interface StructuredReview {
  summary: string;
  overall_score: number;
  risk_level: string;
  findings: Array<{
    severity: string;
    category: string;
    file_path: string;
    line_number: number | null;
    title: string;
    description: string;
    recommendation: string;
    code_suggestion: string | null;
  }>;
}

export class ReviewService {
  constructor(private llm: LLMService = llmService) {}

  async generateAndStoreReview(
    clerkUserId: string,
    repositoryId: string,
    pullNumber: number,
  ) {
    const client = await pool.connect();

    try {
      // 1. Fetch Repository using your existing helper
      const repoDetails = await findRepositoryById(repositoryId);
      if (!repoDetails) {
        throw new Error("Repository not found in database.");
      }
      // 2. Fetch GitHub PR Data
      const prDetails = await githubService.getPullRequestDetails(
        clerkUserId,
        repositoryId,
        pullNumber,
      );
      const headSha = prDetails.head_sha || "unknown_sha";

      // Renamed files are listed by GitHub under their NEW name, but the index
      // holds the old one — so every graph and chunk lookup would miss. Include
      // both so structural expansion still finds the file's callers and tests.
      const changedFilePaths: string[] = [];
      for (const f of prDetails.files as any[]) {
        changedFilePaths.push(f.filename);
        if (f.previous_filename && f.previous_filename !== f.filename) {
          changedFilePaths.push(f.previous_filename);
        }
      }

      const changedFileNames = changedFilePaths.join(", ");
      const ragQuery = `Pull Request Title: ${prDetails.title}. Description: ${prDetails.description || "None"}. Files modified: ${changedFileNames}`;

      // No maxCodeChunks override: that was a SQL LIMIT on one stage, not an
      // output cap, so it starved recall while the token budget went unspent.
      // The context budget does the capping now.
      const retrievedContext = await retrievalService.retrieveReviewContext(
        clerkUserId,
        repositoryId,
        ragQuery,
        changedFilePaths,
      );

      const codebaseChunks = retrievedContext.codeChunks;

      // symbolType now carries the retrieval class (changed_file,
      // graph_dependent, related_test, ...), so the model can see WHY a chunk
      // is present — a caller is different evidence from a coincidental
      // semantic match. It was hardcoded to "unknown" before.
      const codebaseContext = codebaseChunks
        .map(
          (chunk) =>
            `// File: ${chunk.filePath}\n// Symbol: ${chunk.symbolName}\n// Retrieved as: ${chunk.symbolType}\n${chunk.content}`,
        )
        .join("\n\n");

      const classCounts = codebaseChunks.reduce<Record<string, number>>((acc, c) => {
        acc[c.symbolType] = (acc[c.symbolType] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `[Review] Context: ${codebaseChunks.length} code chunk(s) by class —`,
        classCounts,
      );

      // Documentation relevant to THIS PR, by two triggers:
      //  1. semantic — README sections that matched the PR's own ragQuery
      //     (title/description/changed files), already gated by threshold;
      //  2. structural — the PR edits the README itself, in which case its
      //     documented claims should be checked against the same diff.
      // If neither fires, no documentation is attached at all.
      const docChunks = retrievedContext.docChunks || [];
      const touchesDocumentation = changedFilePaths.some((p: string) => isDocumentationFile(p));

      const documentationContext =
        docChunks.length > 0
          ? docChunks
              .map((d) => `// ${d.filePath} § ${d.sectionPath}\n${d.content}`)
              .join("\n\n")
          : "";

      // TEMPORARY verification logging — see utils/readmeDebugLog.ts.
      const docTriggerReason = docChunks.length > 0
        ? "semantic match on PR query"
        : touchesDocumentation
          ? "PR edits the README itself"
          : "none — no documentation attached";
      docRetrievalLog(
        `Review PR #${pullNumber} (${repoDetails.name}): documentation trigger = ${docTriggerReason}. ` +
          `${docChunks.length} section(s) included, ${documentationContext.length} chars ` +
          `(cap 6000 applied at prompt-build time).`,
      );
      docChunks.forEach((d, i) => {
        docRetrievalLog(`  -> included [Doc ${i + 1}] ${d.filePath} § "${d.sectionPath}"`);
      });
      if (docChunks.length === 0 && !touchesDocumentation) {
        docRetrievalLog(
          `  -> <Documentation> block OMITTED from the review prompt, and the drift rules with it. ` +
            `This is correct: documentation is relevance-gated, never attached by default.`,
        );
      }

      // Repository-level framing, present only when the repo reached READY —
      // retrieveReviewContext leaves this null otherwise, so a summary written
      // against an older revision is never presented as current.
      const repo = retrievedContext.repository as any;
      const repositoryOverview = repo
        ? [
            repo.purpose ? `Purpose: ${repo.purpose}` : null,
            repo.summary ? `Summary: ${repo.summary}` : null,
            repo.techStack?.length ? `Tech stack: ${repo.techStack.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : "";

      // 3. Build Prompt & Schema
      const messages = CodeReviewPromptBuilder.buildReviewPrompt(
        repoDetails.name,
        prDetails.title,
        prDetails.description || "",
        prDetails.files,
        codebaseContext,
        // A README-editing PR gets the drift rules even when no section
        // cleared the similarity threshold — the diff itself is the trigger.
        documentationContext ||
          (touchesDocumentation
            ? "(The pull request modifies the README; its diff is included below.)"
            : ""),
        // Provenance: the index tracks the default branch tip, not this PR's
        // base, so the context legitimately predates the diff.
        {
          branch: repoDetails.default_branch ?? undefined,
          sha: repoDetails.last_indexed_sha ?? undefined,
        },
        // Only populated when the repo is READY (see retrieveReviewContext).
        repositoryOverview,
      );
      const schema = CodeReviewPromptBuilder.getReviewSchema();

      // 4. Generate AI Review
      const aiReview = await this.llm.generateStructured<StructuredReview>(
        messages,
        schema,
      );

      // 5. Database Transaction
      await client.query("BEGIN");

      // A. Demote older reviews
      await client.query(
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
        (repository_id, pull_number, head_sha, model, status, summary, overall_score, risk_level, raw_response, is_latest)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
        RETURNING id;
      `,
        [
          repositoryId,
          pullNumber,
          headSha,
          "gemini-2.0-flash",
          "completed",
          aiReview.summary,
          aiReview.overall_score,
          aiReview.risk_level,
          JSON.stringify(aiReview),
        ],
      );
      const newReviewId = reviewRes.rows[0].id;

      // C. Insert Findings
      if (aiReview.findings && aiReview.findings.length > 0) {
        const findingQueries = aiReview.findings.map((finding) => {
          return client.query(
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

      // D. Insert Audit Log (Review Messages)
      const userPrompt = messages.find((m) => m.role === "user")?.content || "";
      await client.query(
        `
        INSERT INTO review_messages (review_id, role, content) 
        VALUES ($1, 'user', $2), ($1, 'ai', $3);
      `,
        [newReviewId, userPrompt, JSON.stringify(aiReview)],
      );

      await client.query("COMMIT");

      

      return { reviewId: newReviewId, ...aiReview };
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("AI Review Generation Failed:", error);
      throw new Error("Failed to generate and save code review.");
    } finally {
      client.release();
    }
  }
}

export const reviewService = new ReviewService();

export const getReviewsForPullRequest = async (
  repositoryId: string,
  pullNumber: number,
) => {
  // 1. Fetch all reviews for this PR, ordered by newest first
  const { rows: reviews } = await pool.query(
    `SELECT * FROM reviews 
     WHERE repository_id = $1 AND pull_number = $2 
     ORDER BY created_at DESC`,
    [repositoryId, pullNumber],
  );

  if (reviews.length === 0) {
    return { latest: null, history: [] };
  }

  // 2. Separate the latest review from the historical ones
  const latest = reviews.find((r) => r.is_latest) || reviews[0];
  const history = reviews.filter((r) => r.id !== latest.id);

  // 3. Fetch the specific inline findings only for the latest review
  const { rows: findings } = await pool.query(
    `SELECT * FROM review_findings WHERE review_id = $1 ORDER BY file_path, line_number`,
    [latest.id],
  );

  // 4. Bump last_accessed_at for the latest review
  await pool.query(
    `UPDATE reviews SET last_accessed_at = NOW() WHERE id = $1`,
    [latest.id]
  );

  return {
    latest: {
      ...latest,
      findings,
    },
    history,
  };
};
