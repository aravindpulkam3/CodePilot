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

  // Documentation gets its own, much smaller budget so a long README section
  // can never crowd out diff content. Reviewing the diff remains the job.
  private static readonly MAX_DOCUMENTATION_LENGTH = 6000;

  /**
   * Where the retrieved repository context came from. Review context is read
   * from the index, which tracks the DEFAULT BRANCH tip — not the PR's base —
   * so it never contains this PR's changes and may even be ahead of what the
   * author branched from. Passing it through lets the prompt say so.
   */
  public static buildReviewPrompt(
    repoName: string,
    prTitle: string,
    prDescription: string,
    files: PRFile[],
    codebaseContext: string,
    documentationContext: string = "",
    provenance?: { branch?: string; sha?: string },
    repositoryOverview: string = "",
  ): LLMMessage[] {
    return [
      {
        role: "system",
        content: this.buildSystemPrompt(repoName, Boolean(documentationContext)),
      },
      {
        role: "user",
        content: this.buildUserPrompt(
          prTitle,
          prDescription,
          files,
          codebaseContext,
          documentationContext,
          provenance,
          repositoryOverview,
        ),
      },
    ];
  }

  private static buildSystemPrompt(repoName: string, hasDocumentation: boolean): string {
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

${hasDocumentation ? this.DOCUMENTATION_RULES : ""}
Return ONLY valid JSON matching the provided schema.
`;
  }

  /**
   * Only injected when documentation was actually retrieved for THIS pull
   * request. Scoping drift detection to the diff is what keeps false
   * positives low: the model must point at changed lines, so it cannot
   * free-associate across the whole repository the way a repo-wide
   * documentation scan would.
   */
  private static readonly DOCUMENTATION_RULES = `
Documentation Consistency

The <Documentation> block contains sections of the repository's README that
are relevant to this pull request.

- README documents INTENDED behaviour, setup steps and project description.
  The code is authoritative for ACTUAL current behaviour.
- If this diff makes the code contradict a documented claim, emit a finding
  with category "documentation", severity "Minor". Name the documented claim
  and the specific changed lines that contradict it.
- Only flag a contradiction you can point at changed lines for. Do NOT flag
  documentation for being merely incomplete, terse, or unpolished.
- If this PR modifies the README itself, check whether the new wording
  matches the code in the same diff.
- Documentation drift must never outrank a correctness or security finding.
`;

  private static buildUserPrompt(
    prTitle: string,
    prDescription: string,
    files: PRFile[],
    codebaseContext: string,
    documentationContext: string = "",
    provenance?: { branch?: string; sha?: string },
    repositoryOverview: string = "",
  ): string {
    const validFiles = files.filter(
      (file) =>
        file.patch &&
        !this.IGNORED_PATTERNS.some((pattern) => pattern.test(file.filename)),
    );

    let prompt = "";

    // Only present when the repository is fully indexed AND summarized. While
    // summarization is still running, saying nothing is correct — a summary
    // generated against an older revision, presented as current, is worse than
    // no architectural framing at all.
    if (repositoryOverview) {
      prompt += `
<RepositoryOverview>
${repositoryOverview}
</RepositoryOverview>
`;
    }

    // Provenance. Without this the model sees pre-change code labelled "the
    // existing repository" alongside the diff labelled "the change", with
    // nothing saying which is authoritative — a systematic false-positive
    // generator ("you changed the signature but the caller still uses the old
    // one", when the caller simply hasn't been re-indexed).
    const origin = provenance?.branch
      ? `\`${provenance.branch}\`${provenance.sha ? `@${provenance.sha.slice(0, 7)}` : ""}`
      : "the repository's default branch";

    prompt += `
<RepositoryContext>
The following code chunks are pulled from the existing repository to give you architectural context. This code is NOT part of the PR diff, but it is related to the files being changed.

PROVENANCE: this context is indexed from ${origin} and does NOT include this pull request's changes. Do NOT report a finding whose only basis is that this context has not been updated to match the diff — that is expected.

Each chunk is labelled with how it was retrieved:
- changed_file: a chunk of a file this PR modifies, shown in full (the diff shows only changed lines)
- graph_dependent: a CALLER of a changed file — check whether this change breaks it
- graph_dependency: something a changed file imports
- related_test: a test covering a changed file
- semantic_chunk: a general similarity match, the weakest signal

${codebaseContext || "No relevant repository context found."}
</RepositoryContext>
`;

    // Omitted entirely when nothing relevant matched — the README is never
    // attached to a review just because the repository has one.
    if (documentationContext) {
      const truncated =
        documentationContext.length > this.MAX_DOCUMENTATION_LENGTH
          ? documentationContext.substring(0, this.MAX_DOCUMENTATION_LENGTH) +
            "\n\n...[DOCUMENTATION TRUNCATED]"
          : documentationContext;

      prompt += `
<Documentation>
README sections relevant to this pull request. These describe INTENDED behaviour and are not part of the diff:

${truncated}
</Documentation>
`;
    }

    prompt += `
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
          description:
            "A highly readable, senior-level summary of the PR changes.",
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
                description:
                  "Must match one of the defined system prompt categories, or 'documentation' for a README/code contradiction.",
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
                description:
                  "A formatted code block showing the exact fix, if applicable.",
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
