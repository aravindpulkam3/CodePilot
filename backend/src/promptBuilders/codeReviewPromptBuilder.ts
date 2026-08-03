import { Type, Schema } from "@google/genai";
import { LLMMessage } from "../services/llm.service.js"; // Adjust path if needed

interface PRFile {
  filename: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

export class CodeReviewPromptBuilder {
  private static readonly IGNORED_PATTERNS = [
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /^dist\//,
    /^build\//,
    /^coverage\//,
    /\.min\.(js|css)$/,
    /\.(jpg|jpeg|png|gif|svg|webp|ico|mp4|webm|wav|mp3|eot|ttf|woff|woff2)$/i,
  ];

  private static readonly MAX_TOTAL_PATCH_LENGTH = 80000;

  // UPGRADE: Added codebaseContext parameter
  public static buildReviewPrompt(
    repoName: string,
    prTitle: string,
    prDescription: string,
    files: PRFile[],
    codebaseContext: string
  ): LLMMessage[] {
    return [
      {
        role: "system",
        content: this.buildSystemPrompt(repoName),
      },
      {
        role: "user",
        content: this.buildUserPrompt(prTitle, prDescription, files, codebaseContext),
      },
    ];
  }

  private static buildSystemPrompt(repoName: string): string {
    // UPGRADE: Added specific RAG instructions (Rule 2 & 4) to your existing rules
    return `
You are a Senior Software Engineer performing a pull request review.

Repository:
${repoName}

Your goal is to provide accurate, actionable, production-quality feedback.

Review priorities (highest to lowest):

1. Correctness
   - Logic bugs
   - Broken edge cases
   - Incorrect assumptions

2. Security
   - Authentication
   - Authorization
   - Injection risks
   - Secrets
   - Unsafe input handling

3. Performance
   - Expensive algorithms
   - Unnecessary allocations
   - Duplicate work
   - N+1 queries

4. Maintainability
   - Complexity
   - Duplication
   - Readability
   - Long-term maintainability

5. Best Practices
   - Language conventions
   - Framework conventions
   - API design

6. Testing
   - Missing tests
   - Missing edge cases

Positive Feedback
- Only include praise if there is something genuinely noteworthy.
- Do not invent compliments.

Important Rules

- Review ONLY the provided <PullRequestDiff>.
- Use the <RepositoryContext> to understand how the changed code interacts with the rest of the system.
- Do NOT suggest changes to code inside the <RepositoryContext> unless it directly relates to the PR diff.
- If context is insufficient, explicitly state that additional context is required.
- Ignore formatting and stylistic preferences unless they affect correctness or maintainability.
- Prefer fewer high-quality findings over many weak observations.
- Every issue should include a concrete recommendation.
- Whenever possible, include an exact replacement code snippet.
- If no issue exists, do not fabricate one.

Scoring

100 = Production-ready
90-99 = Excellent
80-89 = Good
70-79 = Acceptable
Below 70 = Significant issues requiring revision

Risk Levels

Low
No meaningful production risk.

Medium
Some concerns but unlikely to cause production failures.

High
Likely to introduce bugs, security issues or major maintainability problems.

Critical
Likely to cause severe failures or vulnerabilities.

Return ONLY valid JSON matching the provided schema.
`;
  }

  // UPGRADE: Added XML tags and injected codebaseContext
  private static buildUserPrompt(
    prTitle: string,
    prDescription: string,
    files: PRFile[],
    codebaseContext: string
  ): string {
    const validFiles = files.filter(
      (file) =>
        file.patch &&
        !this.IGNORED_PATTERNS.some((pattern) => pattern.test(file.filename)),
    );

    let prompt = `
<RepositoryContext>
The following code chunks are pulled from the existing repository to give you architectural context. This code is NOT part of the PR diff, but it is related to the files being changed:

${codebaseContext || "No relevant repository context found."}
</RepositoryContext>

<PullRequestDiff>
# Pull Request

Title:
${prTitle}

Description:
${prDescription || "No description provided"}

Changed Files:
${validFiles.length}

`;

    let remainingBudget = this.MAX_TOTAL_PATCH_LENGTH;

    for (const file of validFiles) {
      if (remainingBudget <= 0) break;

      let patch = file.patch ?? "";

      if (patch.length > remainingBudget) {
        patch =
          patch.substring(0, remainingBudget) +
          "\n\n...[PATCH TRUNCATED DUE TO TOKEN LIMITS]\nReview only the available portion.";
      }

      remainingBudget -= patch.length;

      prompt += `
==================================================
FILE: ${file.filename}

Status: ${file.status}
Additions: ${file.additions ?? 0}
Deletions: ${file.deletions ?? 0}

PATCH

${patch}

`;
    }

    if (remainingBudget <= 0) {
      prompt += `
NOTE

Some patches were omitted because the maximum prompt size was reached.

Focus only on the files shown above.
Do not speculate about omitted files.
`;
    }

    prompt += `</PullRequestDiff>`;

    return prompt;
  }

  public static getReviewSchema(): Schema {
    return {
      type: Type.OBJECT,
      properties: {
        summary: {
          type: Type.STRING,
          description: "A highly readable, senior-level summary of the PR changes.",
        },
        overall_score: {
          type: Type.INTEGER,
          description: "Score from 1 to 100 based on overall quality.",
        },
        risk_level: {
          type: Type.STRING,
          description: "Must be 'Low', 'Medium', 'High', or 'Critical'.",
        },
        findings: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: {
                type: Type.STRING,
                description: "'Info', 'Minor', 'Major', or 'Critical'",
              },
              category: {
                type: Type.STRING,
                description: "Must match one of the defined system prompt categories.",
              },
              file_path: { type: Type.STRING },
              line_number: { type: Type.INTEGER, nullable: true },
              title: {
                type: Type.STRING,
                description: "A short, descriptive title for the finding.",
              },
              description: {
                type: Type.STRING,
                description: "Detailed explanation of the issue or praise.",
              },
              recommendation: {
                type: Type.STRING,
                description: "Plain text advice on how to resolve the issue.",
              },
              code_suggestion: {
                type: Type.STRING,
                nullable: true,
                description: "A formatted code block showing the exact fix, if applicable.",
              },
            },
            required: [
              "severity",
              "category",
              "file_path",
              "title",
              "description",
              "recommendation",
            ],
          },
        },
      },
      required: ["summary", "overall_score", "risk_level", "findings"],
    };
  }
}