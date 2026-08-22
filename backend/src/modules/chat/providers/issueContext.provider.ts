import { ChatContextProvider, ChatContextPayload, ChatSessionRecord } from "../chat.types.js";
import { pool } from "../../../config/db.js";

export class IssueContextProvider implements ChatContextProvider {
  async buildContext(
    session: ChatSessionRecord,
    _userMessage: string
  ): Promise<ChatContextPayload> {
    if (!session.finding_id) {
      throw new Error("Finding ID is required for ISSUE_CHAT sessions.");
    }

    // Fetch finding details joined with review and repository information
    const { rows } = await pool.query(
      `SELECT 
         f.*, 
         r.pull_number, 
         r.head_sha, 
         r.overall_score,
         r.summary as review_summary,
         rep.name as repo_name,
         rep.owner as repo_owner
       FROM review_findings f
       JOIN reviews r ON r.id = f.review_id
       JOIN repositories rep ON rep.id = r.repository_id
       WHERE f.id = $1`,
      [session.finding_id]
    );

    if (rows.length === 0) {
      throw new Error(`Review finding not found for id: ${session.finding_id}`);
    }

    const finding = rows[0];

    const systemPrompt = `You are a Principal AI Software Engineer discussing a SPECIFIC AI code review finding with the author.

Scoped Finding Context:
- Repository: ${finding.repo_owner}/${finding.repo_name} (PR #${finding.pull_number})
- Target File: ${finding.file_path}
- Target Line: ${finding.line_number ?? "N/A"}
- Severity: ${finding.severity}
- Category: ${finding.category}
- Title: ${finding.title}
- Original Review Explanation:
${finding.description}
- Original Recommendation:
${finding.recommendation}
${
  finding.code_suggestion
    ? `- Original Suggested Fix:\n\`\`\`\n${finding.code_suggestion}\n\`\`\``
    : "- No code fix was originally suggested."
}

Core Instructions for this Conversation:
1. Stay strictly focused on this finding and the relevant code context.
2. When the user asks "Why is this a problem?" or "Why is your suggested approach better?":
   - Explain the underlying root cause (e.g. O(n²) time complexity vs O(n), memory allocation overhead, race condition, injection vulnerability, unexpected mutations, unhandled promise rejections).
   - Compare the current approach vs the recommended approach with clear tradeoffs.
3. When the user asks "Can this be optimized further?" or "Show me an example":
   - Provide concrete, production-grade code snippets with syntax highlighting.
   - Explain space and time complexity tradeoffs.
4. When the user asks "What would happen in production?":
   - Detail real-world failure modes (high CPU load, connection exhaustion, slow response latency, memory leaks, security breaches).
5. Always use clean GitHub-flavored markdown with code fences (\`\`\`language) for any code blocks.`;

    return {
      systemPrompt,
      metadata: {
        findingId: session.finding_id,
        filePath: finding.file_path,
        lineNumber: finding.line_number,
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
      },
    };
  }
}
