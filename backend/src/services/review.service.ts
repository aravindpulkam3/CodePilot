import { pool } from "../config/db.js";
import { findRepositoryById } from "./repository.service.js";
import * as githubService from "./github.service.js";
import { llmService, LLMService } from "./llm.service.js";
import { CodeReviewPromptBuilder } from "../promptBuilders/codeReviewPromptBuilder.js";

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

  async generateAndStoreReview(clerkUserId: string, repositoryId: string, pullNumber: number) {
    const client = await pool.connect();
    
    try {
      // 1. Fetch Repository using your existing helper
      const repoDetails = await findRepositoryById(repositoryId);
      if (!repoDetails) {
        throw new Error("Repository not found in database.");
      }

      // 2. Fetch GitHub PR Data
      const prDetails = await githubService.getPullRequestDetails(clerkUserId, repositoryId, pullNumber);
      const headSha = prDetails.head_sha || 'unknown_sha';

      // 3. Build Prompt & Schema
      const messages = CodeReviewPromptBuilder.buildReviewPrompt(
        repoDetails.name,
        prDetails.title,
        prDetails.description || '',
        prDetails.files
      );
      const schema = CodeReviewPromptBuilder.getReviewSchema();

      // 4. Generate AI Review
      const aiReview = await this.llm.generateStructured<StructuredReview>(messages, schema);

      // 5. Database Transaction
      await client.query('BEGIN');

      // A. Demote older reviews
      await client.query(`
        UPDATE reviews SET is_latest = FALSE 
        WHERE repository_id = $1 AND pull_number = $2;
      `, [repositoryId, pullNumber]);

      // B. Insert the new Review record
      const reviewRes = await client.query(`
        INSERT INTO reviews 
        (repository_id, pull_number, head_sha, model, status, summary, overall_score, risk_level, raw_response, is_latest)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
        RETURNING id;
      `, [
        repositoryId, pullNumber, headSha, 'gemini-2.0-flash', 'completed',
        aiReview.summary, aiReview.overall_score, aiReview.risk_level, JSON.stringify(aiReview)
      ]);
      const newReviewId = reviewRes.rows[0].id;

      // C. Insert Findings
      if (aiReview.findings && aiReview.findings.length > 0) {
        const findingQueries = aiReview.findings.map(finding => {
          return client.query(`
            INSERT INTO review_findings 
            (review_id, severity, category, file_path, line_number, title, description, recommendation, code_suggestion)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
          `, [
            newReviewId, finding.severity, finding.category, finding.file_path, 
            finding.line_number, finding.title, finding.description, 
            finding.recommendation, finding.code_suggestion
          ]);
        });
        await Promise.all(findingQueries);
      }

      // D. Insert Audit Log (Review Messages)
      const userPrompt = messages.find(m => m.role === 'user')?.content || '';
      await client.query(`
        INSERT INTO review_messages (review_id, role, content) 
        VALUES ($1, 'user', $2), ($1, 'ai', $3);
      `, [newReviewId, userPrompt, JSON.stringify(aiReview)]);

      await client.query('COMMIT');

      return { reviewId: newReviewId, ...aiReview };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error("AI Review Generation Failed:", error);
      throw new Error("Failed to generate and save code review.");
    } finally {
      client.release();
    }
  }
}

export const reviewService = new ReviewService();