import { Type, Schema } from "@google/genai";
import type { LLMMessage } from "../../infrastructure/llm/llm.service.js"; // Adjust path if needed
import type {
  ChangedCodeContext,
  EnclosingChunk,
} from "./changedCodeContext.js";
import { chunkMatchesTargets, includedTargets, uncoveredTargets } from "./changedCodeContext.js";
import {
  estimateRequestTokens,
  requestFits,
  type LLMRequestBudget,
} from "../../infrastructure/llm/requestBudget.js";
import {
  reviewCoverageMessage,
  REVIEW_SEVERITIES,
  REVIEW_RISKS,
  REVIEW_CATEGORIES,
  splitReviewPatch,
  type ReviewInputMetadata,
} from "./reviewInput.js";
import type { PullRequestFile } from "../../infrastructure/github/pullRequestSnapshot.js";
import { isDocumentationFile } from "../../shared/utils/documentationPaths.js";

export interface PRFile extends PullRequestFile {
  reviewInclusion?: "full" | "partial" | "none";
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
    /\.(pdf|zip|gz|tar|7z|exe|dll|so|dylib|wasm|bin|class|jar|pyc)$/i,
  ];

  /** Lockfiles, build output, minified and binary assets are never reviewed. */
  public static isReviewableFile(filename: string): boolean {
    return !this.IGNORED_PATTERNS.some((pattern) => pattern.test(filename));
  }

  /** One budget for the actual messages and schema, with whole-hunk inclusion. */
  public static buildBudgetedReviewPrompt(input: {
    repoName: string;
    title: string;
    description: string;
    headSha: string;
    baseSha: string;
    files: PRFile[];
    expectedFiles: number;
    budget: LLMRequestBudget;
    codeContext: string[];
    documentation: string[];
    changedCode: ChangedCodeContext | null;
    excludedEvidence?: ReviewInputMetadata["excludedEvidence"];
  }): { messages: LLMMessage[]; reviewInput: ReviewInputMetadata } {
    const parsed = input.files.map((file) => splitReviewPatch(file));
    const reviewInput: ReviewInputMetadata = {
      version: 1,
      headSha: input.headSha,
      baseSha: input.baseSha,
      acquisition: {
        complete: input.expectedFiles === input.files.length,
        expectedFiles: input.expectedFiles,
        fetchedFiles: input.files.length,
      },
      coverage: "partial",
      files: input.files.map((file, i) => {
        const excluded = !this.isReviewableFile(file.filename);
        const metadataOnly =
          file.status === "renamed" &&
          !!file.previous_filename &&
          !file.patch &&
          file.additions === 0 &&
          file.deletions === 0;
        return {
          filename: file.filename,
          previousFilename: file.previous_filename,
          status: excluded
            ? "excluded"
            : parsed[i] || metadataOnly
              ? "available"
              : "unavailable",
          inclusion: "none",
          reason: excluded
            ? "Excluded by review file policy"
            : parsed[i] || metadataOnly
              ? undefined
              : "Patch unavailable or incomplete",
          hunks: parsed[i]?.map((part) => part.hunk) ?? [],
        };
      }),
      excludedEvidence: input.excludedEvidence ?? [],
      budget: {
        ...input.budget,
        estimatedInputTokens: 0,
        method: "utf8-bytes",
      },
    };
    if (!reviewInput.acquisition.complete)
      throw new Error("GITHUB_PR_FILES_INCOMPLETE");
    const selected = new Map<number, PRFile>();
    const code: string[] = [];
    const rankedCode = [...new Set(input.codeContext)];
    const codeRank = new Map(rankedCode.map((item, index) => [item, index]));
    const docs: string[] = [];
    const enclosing: ChangedCodeContext = {
      headSha: input.headSha,
      files: [],
      fullyHeadCoveredFiles: [],
    };
    const schema = this.getReviewSchema();
    const extracted = new Map(input.changedCode?.files.map((file) => [file.filename, file]) ?? []);
    const updateEnclosingCoverage = () => {
      for (const [index, file] of selected) {
        const original = extracted.get(file.filename);
        const accepted = enclosing.files.find((entry) => entry.filename === file.filename);
        const targets = includedTargets(original?.targets ?? [], file.patch ?? "");
        const chunks = accepted?.chunks ?? [];
        const uncovered = uncoveredTargets(targets, chunks);
        const notApplicable = file.status === "removed" || !parsed[index]?.length;
        reviewInput.files[index].enclosing = {
          status: notApplicable ? "not-applicable" : !chunks.length || !targets.length ? "unavailable"
            : uncovered.length ? "partial" : "complete",
          uncovered,
          split: chunks.some((chunk) => chunk.split),
          reason: notApplicable ? undefined : original?.coverage.startsWith("fallback:")
            ? original.coverage.slice("fallback:".length)
            : original?.candidateLimitReached ? "Candidate resource limit; coverage refers only to retained source"
            : !original?.targets ? "Enclosing source unavailable"
            : !chunks.length ? "Context budget"
            : uncovered.length ? "Context budget or source absent from enclosing snippets" : undefined,
        };
      }
      for (const [index] of input.files.entries()) {
        if (!selected.has(index)) delete reviewInput.files[index].enclosing;
      }
    };
    const render = () => {
      updateEnclosingCoverage();
      reviewInput.coverage = reviewInput.files.every(
        (file) => file.status === "excluded" || file.inclusion === "full",
      )
        ? "complete"
        : "partial";
      const messages = this.buildReviewPrompt(
        input.repoName,
        input.title,
        input.description,
        [...selected.entries()].map(([index, file]) => ({
          ...file,
          reviewInclusion: reviewInput.files[index].inclusion,
        })),
        code.join("\n\n"),
        docs.join("\n\n"),
        { headSha: input.headSha, baseSha: input.baseSha },
        "",
        enclosing,
      );
      messages[0].content += `\n${reviewCoverageMessage(reviewInput)}\nScore, risk and summary apply only to the supplied changes. Never claim omitted changes are safe. ${reviewInput.excludedEvidence.length} repository evidence item(s) could not be verified at PR head; absence of evidence is not proof of a bug.`;
      const support = reviewInput.files.filter((file) => file.enclosing && file.enclosing.status !== "not-applicable");
      messages[0].content += `\nEnclosing source: ${support.filter((file) => file.enclosing?.status === "complete").length} of ${support.length} included files have all changed-source targets represented in enclosing snippets. Other files have partial or unavailable enclosing source. This is separate from diff coverage. Even complete source-span coverage does not establish full function context or functional understanding; split symbols may omit guards, initialization or other control flow. Structural hints are not verbatim source.`;
      return messages;
    };
    const fits = () => requestFits(render(), schema, input.budget);
    if (!fits()) throw new Error("REVIEW_CONTEXT_TOO_SMALL");

    for (const [index, file] of input.files.entries()) {
      const coverage = reviewInput.files[index];
      if (coverage.status !== "available") continue;
      const parts = parsed[index] ?? [];
      const fullPatch =
        file.patch ||
        `Metadata-only change: ${file.status}${file.previous_filename ? ` from ${file.previous_filename}` : ""}; no textual additions or deletions.`;
      selected.set(index, { ...file, patch: fullPatch });
      coverage.inclusion = "full";
      if (fits()) {
        coverage.hunks.forEach((hunk) => {
          hunk.included = true;
        });
        continue;
      }
      selected.delete(index);
      coverage.inclusion = "none";
      const included: string[] = [];
      for (const part of parts) {
        selected.set(index, {
          ...file,
          patch: [...included, part.text].join("\n"),
        });
        coverage.inclusion = "partial";
        if (fits()) {
          included.push(part.text);
          part.hunk.included = true;
        } else {
          if (included.length)
            selected.set(index, { ...file, patch: included.join("\n") });
          else {
            selected.delete(index);
            coverage.inclusion = "none";
          }
        }
      }
      if (parts.length && parts.every((part) => part.hunk.included))
        coverage.inclusion = "full";
      else coverage.reason = "Context budget; omitted hunks were not sent";
    }
    if (!selected.size) throw new Error("REVIEW_NO_USABLE_CHANGES");

    // Diffs are fixed first. Share the remaining code allowance, then redistribute
    // unused space. Retrieval order is already ranked; never reorder that lane.
    const candidateFiles: Array<{ accepted: ChangedCodeContext["files"][number]; candidates: EnclosingChunk[] }> = [];
    for (const file of input.changedCode?.files ?? []) {
      const selectedFile = Array.from(selected.values()).find((entry) => entry.filename === file.filename);
      if (!selectedFile) continue;
      const targets = includedTargets(file.targets ?? [], selectedFile.patch ?? "");
      const accepted = { ...file, chunks: [] as EnclosingChunk[] };
      enclosing.files.push(accepted);
      candidateFiles.push({ accepted, candidates: file.chunks.filter((chunk) => chunkMatchesTargets(chunk, targets)) });
    }
    const enclosingCandidates = [] as Array<{ accepted: ChangedCodeContext["files"][number]; chunk: EnclosingChunk }>;
    // Round-robin only among relevant candidates. Real source precedes skeletons.
    for (const synthetic of [false, true]) {
      const queues = candidateFiles.map((file) => ({ ...file, candidates: file.candidates.filter((c) => (c.symbolType === "class_skeleton") === synthetic) }));
      const max = Math.max(0, ...queues.map((file) => file.candidates.length));
      for (let i = 0; i < max; i++) for (const file of queues) {
        if (file.candidates[i]) enclosingCandidates.push({ accepted: file.accepted, chunk: file.candidates[i] });
      }
    }
    const maxInput = input.budget.contextTokens - input.budget.outputTokens - input.budget.safetyTokens;
    const size = () => estimateRequestTokens(render(), schema);
    const baseSize = size();
    let currentSize = baseSize;
    const share = Math.max(0, Math.floor((maxInput - baseSize) / 2));
    const tryEnclosing = (item: typeof enclosingCandidates[number], ceiling: number) => {
      if (Buffer.byteLength(item.chunk.content, "utf8") > ceiling - currentSize) return false;
      item.accepted.chunks.push(item.chunk);
      const nextSize = size();
      if (nextSize <= ceiling) { currentSize = nextSize; return true; }
      item.accepted.chunks.pop();
      return false;
    };
    const tryCode = (item: string, ceiling: number) => {
      if (Buffer.byteLength(item, "utf8") > ceiling - currentSize) return false;
      code.push(item);
      code.sort((a, b) => codeRank.get(a)! - codeRank.get(b)!);
      const nextSize = size();
      if (nextSize <= ceiling) { currentSize = nextSize; return true; }
      code.splice(code.indexOf(item), 1);
      return false;
    };
    const deferredEnclosing = enclosingCandidates.filter((item) => !tryEnclosing(item, baseSize + share));
    const codeStart = currentSize;
    const deferredCode = rankedCode.filter((item) => !tryCode(item, Math.min(maxInput, codeStart + share)));
    // Ranked repository evidence gets first opportunity at redistributed space;
    // an oversized item never blocks a later fitting candidate in either lane.
    for (const item of deferredCode) tryCode(item, maxInput);
    for (const item of deferredEnclosing) tryEnclosing(item, maxInput);
    for (const item of new Set(input.documentation)) {
      docs.push(item);
      if (!fits()) docs.pop();
    }
    const messages = render();
    if (!requestFits(messages, schema, input.budget))
      throw new Error("REVIEW_CONTEXT_TOO_SMALL");
    reviewInput.budget.estimatedInputTokens = estimateRequestTokens(
      messages,
      schema,
    );
    return { messages, reviewInput };
  }

  /** Pure renderer. Generation uses buildBudgetedReviewPrompt and validates again at the provider. */
  public static buildReviewPrompt(
    repoName: string,
    prTitle: string,
    prDescription: string,
    files: PRFile[],
    codebaseContext: string,
    documentationContext: string = "",
    provenance?: {
      branch?: string;
      sha?: string;
      headSha?: string;
      baseSha?: string;
    },
    repositoryOverview: string = "",
    // Post-change enclosing code per changed file, from the PR head. See
    // changedCodeContext.ts — already capped, rendered in full here.
    changedCode: ChangedCodeContext | null = null,
  ): LLMMessage[] {
    const hasEnclosingCode = Boolean(
      changedCode?.files.some((f) => f.chunks.length > 0),
    );
    return [
      {
        role: "system",
        content: this.buildSystemPrompt(
          repoName,
          Boolean(documentationContext) ||
            files.some((file) => isDocumentationFile(file.filename)),
          hasEnclosingCode,
        ),
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
          changedCode,
        ),
      },
    ];
  }

  private static readonly ENCLOSING_CODE_RULE = `
- Code under "ENCLOSING CODE AT PR HEAD" inside <PullRequestDiff> is the post-change version of the functions, methods or classes that contain the changed lines, from the same revision as the patch. Use it to understand each change in its enclosing scope. Repository context, when supplied, is verified at the recorded PR head.`;

  private static renderEnclosingChunk(chunk: EnclosingChunk): string {
    return `// Symbol: ${chunk.qualifiedName} (${chunk.symbolType}, lines ${chunk.startLine}-${chunk.endLine})${chunk.split ? " — partial symbol" : ""}\n${chunk.structuralContext ? `Structural hints (not verbatim source):\n${chunk.structuralContext}\n` : ""}${chunk.content}`;
  }

  private static buildSystemPrompt(
    repoName: string,
    hasDocumentation: boolean,
    hasEnclosingCode: boolean = false,
  ): string {
    return `
You are a Senior Software Engineer performing a pull request review.

Repository:
${repoName}

Your goal is to provide accurate, actionable, production-quality feedback.

Review priorities (highest to lowest):

Finding category values must be exactly one of: ${REVIEW_CATEGORIES.join(", ")}.

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
- If no issue exists, do not fabricate one.${hasEnclosingCode ? this.ENCLOSING_CODE_RULE : ""}

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

When supplied, the <Documentation> block contains repository documentation
relevant to this pull request. Changed documentation can also appear in the diff.

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
    provenance?: {
      branch?: string;
      sha?: string;
      headSha?: string;
      baseSha?: string;
    },
    repositoryOverview: string = "",
    changedCode: ChangedCodeContext | null = null,
  ): string {
    const enclosingByFile = new Map(
      (changedCode?.files ?? [])
        .filter((f) => f.chunks.length > 0)
        .map((f) => [f.filename, f.chunks]),
    );
    const enclosingHeader = `ENCLOSING CODE AT PR HEAD (${(changedCode?.headSha ?? "").slice(0, 7)}) — same revision as this patch's + lines`;

    const validFiles = files.filter(
      (file) => file.patch && this.isReviewableFile(file.filename),
    );

    let prompt = "";

    // Deterministic repository profile (purpose, modules, runtime services,
    // dependencies) — capped, and keyed to the indexed revision.
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

PROVENANCE: ${provenance?.headSha ? `Source verified at PR head ${provenance.headSha}. PR base tip: ${provenance.baseSha ?? "unknown"}; patches use GitHub PR diff semantics (merge base to head).` : `Discovery context from ${origin}; revision unverified. Do not use it as factual evidence.`}

Retrieval labels describe candidate discovery, not verified relationships:
- changed_file: a changed file
- graph_dependent: an indexed importer, not proof of a call
- graph_dependency: an indexed import target
- related_test: a candidate test, not proof of coverage
- semantic_chunk: a similarity match

${codebaseContext || "No relevant repository context found."}
</RepositoryContext>
`;

    // Omitted entirely when nothing relevant matched — the README is never
    // attached to a review just because the repository has one.
    if (documentationContext) {
      prompt += `
<Documentation>
README sections relevant to this pull request. These describe INTENDED behaviour and are not part of the diff:

${documentationContext}
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

    for (const file of validFiles) {
      prompt += `
==================================================
FILE: ${file.filename}

Status: ${file.status}
Previous path: ${file.previous_filename ?? "unchanged"}
Input coverage: ${file.reviewInclusion === "partial" ? "PARTIAL; only the hunks shown were supplied, other hunks are omitted" : "supplied patch"}
Additions (whole file): ${file.additions ?? 0}
Deletions (whole file): ${file.deletions ?? 0}

PATCH

${file.patch}

`;

      // Accounted for in the complete request budget.
      const enclosing = enclosingByFile.get(file.filename);
      if (enclosing) {
        prompt += `${enclosingHeader}

${enclosing.map((c) => this.renderEnclosingChunk(c)).join("\n\n")}

`;
        enclosingByFile.delete(file.filename);
      }
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
          minimum: 1,
          maximum: 100,
          description: "Score from 1 to 100 based on overall quality.",
        },
        risk_level: {
          type: Type.STRING,
          enum: REVIEW_RISKS,
          description: "Must be 'Low', 'Medium', 'High', or 'Critical'.",
        },
        findings: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              severity: {
                type: Type.STRING,
                enum: REVIEW_SEVERITIES,
                description: "'Info', 'Minor', 'Major', or 'Critical'",
              },
              category: {
                type: Type.STRING,
                enum: REVIEW_CATEGORIES,
                description:
                  "Use the exact lowercase category value; documentation covers README/code contradictions.",
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
