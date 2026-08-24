import { pool } from "../config/db.js";
import { findRepositoryById } from "./repository.service.js";
import * as githubService from "./github.service.js";
import { llmService, LLMService } from "./llm.service.js";
import { CodeReviewPromptBuilder } from "../promptBuilders/codeReviewPromptBuilder.js";
import { retrievalService } from "./retreival.service.js";
import { repositorySyncService } from "./repositorySync.service.js";
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

      const changedFilePaths = prDetails.files.map((f: any) => f.filename);
      const changedFileNames = changedFilePaths.join(", ");
      const ragQuery = `Pull Request Title: ${prDetails.title}. Description: ${prDetails.description || "None"}. Files modified: ${changedFileNames}`;

      // Fetch top 5 chunks using the review retrieval context
      const retrievedContext = await retrievalService.retrieveReviewContext(
        clerkUserId,
        repositoryId,
        ragQuery,
        changedFilePaths,
        { maxCodeChunks: 5 }
      );
      
      const codebaseChunks = retrievedContext.codeChunks;

      console.log("length of codebase chunks", codebaseChunks.length)

      const codebaseContext = codebaseChunks
        .map(
          (chunk) =>
            `// File: ${chunk.filePath}\n// Symbol: ${chunk.symbolName} (${chunk.symbolType})\n${chunk.content}`,
        )
        .join("\n\n");
        
      codebaseChunks.forEach((chunk)=>{
        console.log("relevant context files", chunk.filePath);
      });

      // 3. Build Prompt & Schema
      const messages = CodeReviewPromptBuilder.buildReviewPrompt(
        repoDetails.name,
        prDetails.title,
        prDetails.description || "",
        prDetails.files,
        codebaseContext,
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
