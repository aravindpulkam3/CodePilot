import { ChatContextProvider, ChatContextPayload, ChatSessionRecord } from "../chat.types.js";
import { pool } from "../../../config/db.js";

export class ReviewContextProvider implements ChatContextProvider {
  async buildContext(
    session: ChatSessionRecord,
    _userMessage: string
  ): Promise<ChatContextPayload> {
    if (!session.review_id) {
      throw new Error("Review ID is required for REVIEW_CHAT sessions.");
    }

    // 1. Fetch Review summary & metadata
    const { rows: reviewRows } = await pool.query(
      `SELECT r.*, rep.name as repo_name 
       FROM reviews r 
       JOIN repositories rep ON rep.id = r.repository_id 
       WHERE r.id = $1`,
      [session.review_id]
    );

    if (reviewRows.length === 0) {
      throw new Error(`Review not found for id: ${session.review_id}`);
    }

    const review = reviewRows[0];

    // 2. Fetch all review findings
    const { rows: findings } = await pool.query(
      `SELECT * FROM review_findings 
       WHERE review_id = $1 
       ORDER BY 
         CASE severity 
           WHEN 'Critical' THEN 1 
           WHEN 'Major' THEN 2 
           WHEN 'Minor' THEN 3 
           ELSE 4 
         END, 
         file_path ASC`,
      [session.review_id]
    );

    const findingsSummary = findings
      .map(
        (f, i) =>
          `[Finding ${i + 1}]: [${(f.severity || 'INFO').toUpperCase()}] ${f.category || 'general'} in ${f.file_path}:${f.line_number || 'N/A'}
Title: ${f.title}
Description: ${f.description}
Recommendation: ${f.recommendation}
${f.code_suggestion ? `Suggested Fix:\n\`\`\`\n${f.code_suggestion}\n\`\`\`` : ''}`
      )
      .join("\n\n----------------------------------------\n\n");

    const systemPrompt = `You are the Lead Code Reviewer for the repository "${review.repo_name}".
You are discussing the overall AI Code Review for Pull Request #${review.pull_number}.

Review Overview:
- Overall Score: ${review.overall_score}/100
- Risk Level: ${review.risk_level}
- Target Commit: ${review.head_sha?.slice(0, 7) || 'N/A'}
- Review Summary: ${review.summary || 'No summary available'}

Total Findings Identified (${findings.length}):
${findingsSummary || 'No specific findings were recorded.'}

Guidelines for this conversation:
1. Help the engineer understand the review, prioritize what to fix first, and identify any potential false positives.
2. Provide step-by-step remediation plans and guidance on architecture or code quality.
3. Be direct, constructive, and provide actionable examples in clean markdown.`;

    return {
      systemPrompt,
      metadata: {
        reviewId: session.review_id,
        pullNumber: review.pull_number,
        findingsCount: findings.length,
      },
    };
  }
}
