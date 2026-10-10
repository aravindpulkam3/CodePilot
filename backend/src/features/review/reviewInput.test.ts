import { describe, test } from "node:test";
import { changedSourceTargets, parseChangedLines, type ChangedCodeContext, type EnclosingChunk } from "./changedCodeContext.js";
import assert from "node:assert/strict";
import { CodeReviewPromptBuilder, type PRFile } from "./codeReviewPromptBuilder.js";
import { applyReviewInput, splitReviewPatch, REVIEW_CATEGORIES, REVIEW_RISKS, REVIEW_SEVERITIES } from "./reviewInput.js";
import { createRequestBudget, estimateRequestTokens, requestFits, ollamaRequestBudget } from "../../infrastructure/llm/requestBudget.js";

const hunk = (line: number, size = 3) => `@@ -${line} +${line} @@\n-old\n+${"x".repeat(size)}`;
const file = (name = "a.ts", patch = hunk(1)): PRFile => ({ filename: name, status: "modified", patch });
const build = (files: PRFile[], contextTokens = 32768, codeContext: string[] = [], documentation: string[] = []) => CodeReviewPromptBuilder.buildBudgetedReviewPrompt({
  repoName: "repo", title: "Change", description: "Description", headSha: "head", baseSha: "base",
  files, expectedFiles: files.length, budget: createRequestBudget(contextTokens), codeContext, documentation, changedCode: null,
});
const fits = (result: ReturnType<typeof build>) => {
  assert.equal(requestFits(result.messages, CodeReviewPromptBuilder.getReviewSchema(), result.reviewInput.budget), true);
  assert.equal(result.reviewInput.budget.estimatedInputTokens, estimateRequestTokens(result.messages, CodeReviewPromptBuilder.getReviewSchema()));
};

test("final evidence manifest reports only selected snippets and deduplicated indices", () => {
  const huge = "OMITTED_SUPPORT".repeat(20000);
  const small = "const usefulContext = true;";
  const doc = "Configuration supports this behavior.";
  const result = build([file()], 12000, [huge, small, small], [doc, doc]);
  assert.deepEqual(result.selection.codeIndices, [1]);
  assert.deepEqual(result.selection.documentIndices, [0]);
  assert.ok(result.messages.some((m) => m.content.includes(small)));
  assert.ok(!result.messages.some((m) => m.content.includes("OMITTED_SUPPORT")));
  assert.equal(result.selection.files.length, 1);
  fits(result);
});

describe("deterministic review output validation", () => {
  const valid = (): any => ({ summary: "Assessment", overall_score: 80, risk_level: "Low", findings: [{
    severity: "Major", category: "correctness", file_path: "a.ts", title: "Bug",
    description: "Cause", recommendation: "Fix", line_number: 1, code_suggestion: null,
  }] });
  const input = () => build([file()]).reviewInput;
  test("schema enums and score bounds agree with runtime validation", () => {
    const props = CodeReviewPromptBuilder.getReviewSchema().properties!;
    const finding = props.findings.items!.properties!;
    assert.deepEqual(props.risk_level.enum, REVIEW_RISKS);
    assert.deepEqual(finding.category.enum, REVIEW_CATEGORIES);
    assert.deepEqual(finding.severity.enum, REVIEW_SEVERITIES);
    assert.equal(props.overall_score.minimum, 1); assert.equal(props.overall_score.maximum, 100);
    for (const category of REVIEW_CATEGORIES) for (const severity of REVIEW_SEVERITIES) for (const risk of REVIEW_RISKS) {
      const result = valid(); result.findings[0].category = category;
      result.findings[0].severity = severity; result.risk_level = risk;
      assert.doesNotThrow(() => applyReviewInput(result, input()));
    }
    for (const score of [1, 100]) assert.equal(applyReviewInput({ ...valid(), overall_score: score }, input()).overall_score, score);
  });
  for (const [field, values] of Object.entries({
    overall_score: [0, 101, 1.5, "80", null, undefined, NaN, Infinity],
    risk_level: ["low", "Unknown", "", null, 1], summary: ["", " \n", null, 1],
    findings: [null, {}, "findings"],
  })) {
    test(`rejects malformed ${field}`, () => {
      for (const value of values) assert.throws(() => applyReviewInput({ ...valid(), [field]: value }, input()), /REVIEW_OUTPUT_INCOMPLETE/);
    });
  }
  for (const [field, values] of Object.entries({
    severity: ["major", "Unknown", 1], category: ["Correctness", "unknown", 1],
    line_number: ["1", 1.5, {}, [], true, NaN, Infinity],
    code_suggestion: [1, {}, [], true],
  })) {
    test(`rejects malformed finding ${field}`, () => {
      for (const value of values) {
        const result = valid(); result.findings[0][field] = value;
        assert.throws(() => applyReviewInput(result, input()), /REVIEW_OUTPUT_INCOMPLETE/);
      }
    });
  }
  test("required finding text must be nonblank", () => {
    for (const field of ["file_path", "title", "description", "recommendation", "category", "severity"]) {
      for (const value of ["", " \n", null, undefined, 1]) {
        const result = valid(); result.findings[0][field] = value;
        assert.throws(() => applyReviewInput(result, input()), /REVIEW_OUTPUT_INCOMPLETE/);
      }
    }
  });
  test("optional omission/null stays valid; blank suggestions normalize without altering real code", () => {
    for (const value of [undefined, null]) {
      const result = valid(); delete result.findings[0].line_number; delete result.findings[0].code_suggestion;
      if (value === null) Object.assign(result.findings[0], { line_number: null, code_suggestion: null });
      const saved = applyReviewInput(result, input()).findings[0];
      assert.equal(saved.line_number, null); assert.equal(saved.code_suggestion, null);
    }
    for (const suggestion of ["", " \n", "  return 1;\n", "```ts\nreturn 1;\n```"]) {
      const result = valid(); result.findings[0].code_suggestion = suggestion;
      assert.equal(applyReviewInput(result, input()).findings[0].code_suggestion, suggestion.trim() ? suggestion : null);
    }
  });
  test("empty findings, file filtering, file-level anchors and partial scoring remain intact", () => {
    assert.deepEqual(applyReviewInput({ ...valid(), findings: [] }, input()).findings, []);
    for (const line of [null, 0, -1, 999]) {
      const result = valid(); result.findings[0].line_number = line;
      assert.equal(applyReviewInput(result, input()).findings[0].line_number, null);
    }
    const result = valid(); result.findings.push({ ...result.findings[0], file_path: "absent.ts" });
    assert.equal(applyReviewInput(result, input()).findings.length, 1);
    const partial = { ...input(), coverage: "partial" as const };
    const saved = applyReviewInput(valid(), partial);
    assert.equal(saved.overall_score, null); assert.equal(saved.risk_level, null);
    assert.throws(() => applyReviewInput({ ...valid(), overall_score: 101 }, partial), /REVIEW_OUTPUT_INCOMPLETE/);
  });
});

describe("complete review input budget", () => {
  test("small PR includes every hunk and accounts for system, metadata and schema", () => {
    const result = build([file()]);
    fits(result);
    assert.equal(result.reviewInput.coverage, "complete");
    assert.equal(result.reviewInput.files[0].inclusion, "full");
    assert.ok(result.reviewInput.budget.estimatedInputTokens > result.messages[1].content.length);
    assert.match(result.messages[1].content, /PR head head/);
  });

  test("optional context never displaces a fitting changed patch", () => {
    const result = build([file()], 32768, ["unused code".repeat(10000)], ["documentation".repeat(10000)]);
    fits(result);
    assert.equal(result.reviewInput.coverage, "complete");
    assert.doesNotMatch(result.messages[1].content, /unused code|documentationdocumentation/);
    assert.match(result.messages[1].content, /\+xxx/);
  });

  test("one enormous hunk is omitted whole while a smaller file can still fit", () => {
    const result = build([file("huge.ts", hunk(1, 100000)), file("small.ts")]);
    fits(result);
    assert.equal(result.reviewInput.coverage, "partial");
    assert.equal(result.reviewInput.files[0].inclusion, "none");
    assert.equal(result.reviewInput.files[1].inclusion, "full");
    assert.doesNotMatch(result.messages[1].content, /FILE: huge.ts/);
  });

  test("a file is partially included only at complete hunk boundaries", () => {
    const first = hunk(1, 8000);
    const second = hunk(20, 8000);
    const result = build([file("a.ts", `${first}\n${second}`)], 24000);
    fits(result);
    assert.equal(result.reviewInput.files[0].inclusion, "partial");
    assert.deepEqual(result.reviewInput.files[0].hunks.map((part) => part.included), [true, false]);
    assert.ok(result.messages[1].content.includes(first));
    assert.ok(!result.messages[1].content.includes(second));
    assert.doesNotMatch(result.messages[1].content, /TRUNCATED/);
  });

  test("multiple files over budget retain exact omitted-hunk accounting", () => {
    const result = build(Array.from({ length: 20 }, (_, i) => file(`f${i}.ts`, hunk(1, 4000))), 24000);
    fits(result);
    assert.equal(result.reviewInput.coverage, "partial");
    const included = result.reviewInput.files.filter((entry) => entry.inclusion === "full");
    assert.ok(included.length > 0 && included.length < 20);
    assert.equal(result.reviewInput.files.flatMap((entry) => entry.hunks).filter((part) => !part.included).length, 20 - included.length);
  });

  test("no useful request fails without sending a fragment", () => {
    assert.throws(() => build([file()], 1000), /REVIEW_CONTEXT_TOO_SMALL/);
    assert.throws(() => build([file("huge.ts", hunk(1, 100000))]), /REVIEW_NO_USABLE_CHANGES/);
  });

  test("unavailable patches, policy exclusions and metadata-only renames stay distinct", () => {
    const result = build([
      file(), { filename: "missing.ts", status: "modified", additions: 1, deletions: 0 },
      { filename: "image.png", status: "added" }, { filename: "unknown", status: "modified", additions: 0, deletions: 0 },
      { filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 0, deletions: 0 },
    ]);
    fits(result);
    assert.deepEqual(result.reviewInput.files.map((entry) => entry.status), ["available", "unavailable", "excluded", "unavailable", "available"]);
    assert.equal(result.reviewInput.files[4].inclusion, "full");
    assert.equal(result.reviewInput.coverage, "partial");
  });

  test("additions, deletions and rename edits have complete diff accounting", () => {
    const result = build([
      { filename: "add.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+added" },
      { filename: "gone.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-gone" },
      { ...file("new.ts"), previous_filename: "old.ts", status: "renamed" },
    ]);
    fits(result);
    assert.equal(result.reviewInput.coverage, "complete");
  });

  test("truncated or count-mismatched GitHub patches are unavailable", () => {
    assert.equal(splitReviewPatch(file("a.ts", "@@ -1,2 +1,2 @@\n-old\n+new")), null);
    assert.equal(splitReviewPatch({ ...file(), additions: 4 }), null);
    const result = build([file(), file("truncated.ts", "@@ -1,2 +1,2 @@\n-old\n+new")]);
    assert.equal(result.reviewInput.files[1].status, "unavailable");
  });

  test("Unicode, schema and framing are included under every tested limit", () => {
    for (const limit of [16000, 24000, 32768, 65536]) {
      fits(build(Array.from({ length: 8 }, (_, i) => file(`f${i}.ts`, `@@ -1 +1 @@\n-old\n+${"\u{1f680}".repeat(800)}`)), limit));
    }
  });

  test("model context uses installed metadata or explicit configuration; invalid limits fail", () => {
    const info = { "general.architecture": "qwen2", "qwen2.context_length": 32768 };
    assert.equal(ollamaRequestBudget(info, "").contextTokens, 32768);
    assert.equal(ollamaRequestBudget(info, "num_ctx 16384").contextTokens, 16384);
    assert.equal(ollamaRequestBudget(info, "num_ctx 16384", "8192").contextTokens, 8192);
    assert.throws(() => ollamaRequestBudget(info, "", "65536"), /REVIEW_CONTEXT_UNAVAILABLE/);
    assert.throws(() => ollamaRequestBudget({}, ""), /REVIEW_CONTEXT_UNAVAILABLE/);
  });

  test("persisted/API payload preserves partial coverage, revision and safe line anchors", () => {
    const input = build([file(), { filename: "missing.ts", status: "modified" }]).reviewInput;
    const finding = { severity: "Major", category: "correctness", file_path: "a.ts", line_number: 999, title: "Bug", description: "Cause", recommendation: "Fix", code_suggestion: null };
    const result = applyReviewInput({ summary: "Assessment", overall_score: 95, risk_level: "Low", findings: [finding, { ...finding, file_path: "missing.ts" }] }, input);
    const stored = JSON.parse(JSON.stringify(result));
    assert.equal(stored.overall_score, null);
    assert.equal(stored.risk_level, null);
    assert.match(stored.summary, /^Partial review:/);
    assert.equal(stored.head_sha, "head");
    assert.equal(stored.base_sha, "base");
    assert.deepEqual(stored.review_input, JSON.parse(JSON.stringify(input)));
    assert.equal(stored.findings.length, 1);
    assert.equal(stored.findings[0].line_number, null);
  });
});


const enclosingChunk = (name: string, start: number, end: number, content: string, startLine = 1, endLine = 1): EnclosingChunk => ({
  qualifiedName: name, symbolName: name, symbolType: "function", startLine, endLine, content,
  sourceSpans: [{ start, end }],
});
const buildWithEnclosing = (files: PRFile[], changedCode: ChangedCodeContext, codeContext: string[] = [], contextTokens = 32768) =>
  CodeReviewPromptBuilder.buildBudgetedReviewPrompt({
    repoName: "repo", title: "Change", description: "Description", headSha: "head", baseSha: "base",
    files, expectedFiles: files.length, budget: createRequestBudget(contextTokens), codeContext, documentation: [], changedCode,
  });
const changedContext = (filename: string, patch: string, source: string, chunks: EnclosingChunk[]): ChangedCodeContext => ({
  headSha: "head", fullyHeadCoveredFiles: [filename], files: [{
    filename, coverage: "guaranteed", unmapped: [], chunks,
    targets: changedSourceTargets(parseChangedLines(patch), source),
  }],
});

describe("final enclosing selection and coverage", () => {
  test("six changed functions fit without a four-chunk cutoff", () => {
    const source = Array.from({ length: 6 }, (_, i) => `function f${i}() {}`).join("\n");
    const patch = "@@ -0,0 +1,6 @@\n" + source.split("\n").map((line) => "+" + line).join("\n");
    let offset = 0;
    const chunks = source.split("\n").map((line, i) => {
      const chunk = enclosingChunk("f" + i, offset, offset + line.length, line, i + 1, i + 1);
      offset += line.length + 1; return chunk;
    });
    const result = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, source, chunks));
    fits(result);
    assert.equal(result.reviewInput.files[0].enclosing?.status, "complete");
    for (let i = 0; i < 6; i++) assert.match(result.messages[1].content, new RegExp("// Symbol: f" + i));
  });

  test("budget omissions are measured from accepted spans, independently of diff coverage", () => {
    const patch = "@@ -0,0 +1 @@\n+abcdef";
    const chunks = [enclosingChunk("left", 0, 3, "abc"), enclosingChunk("right", 3, 6, "def" + "x".repeat(100000))];
    const result = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "abcdef", chunks));
    fits(result);
    assert.equal(result.reviewInput.coverage, "complete");
    assert.equal(result.reviewInput.files[0].enclosing?.status, "partial");
    assert.deepEqual(result.reviewInput.files[0].enclosing?.uncovered, ["added lines 1-1"]);
    assert.match(result.messages[1].content, /Symbol: left/);
    assert.doesNotMatch(result.messages[1].content, /Symbol: right/);
    const stored = applyReviewInput({ summary: "Assessment", overall_score: 80, risk_level: "Low", findings: [] }, result.reviewInput);
    assert.equal(stored.overall_score, 80, "support limitations do not change diff-based grading rules");
    assert.deepEqual(JSON.parse(JSON.stringify(stored)).review_input.files[0].enclosing, result.reviewInput.files[0].enclosing);
  });

  test("dropping a redundant chunk does not downgrade actual complete coverage", () => {
    const patch = "@@ -0,0 +1 @@\n+abc";
    const chunks = [enclosingChunk("small", 0, 3, "abc"), enclosingChunk("redundant", 0, 3, "abc" + "x".repeat(100000))];
    const result = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "abc", chunks));
    assert.equal(result.reviewInput.files[0].enclosing?.status, "complete");
    assert.doesNotMatch(result.messages[1].content, /Symbol: redundant/);
  });

  test("omitted hunks do not acquire enclosing snippets or appear as enclosing coverage gaps", () => {
    const patch = hunk(1, 3) + "\n" + hunk(3, 100000);
    const source = "xxx\nkeep\n" + "x".repeat(100000);
    const chunks = [enclosingChunk("included", 0, 3, "xxx"), enclosingChunk("omitted", 9, source.length, "omitted-hunk-code", 3, 3)];
    const result = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, source, chunks));
    assert.equal(result.reviewInput.coverage, "partial");
    assert.equal(result.reviewInput.files[0].enclosing?.status, "complete");
    assert.doesNotMatch(result.messages[1].content, /omitted-hunk-code/);
    fits(result);
  });

  test("ranked callers/tests share space; oversized candidates do not block later snippets", () => {
    const patch = hunk(1);
    const chunks = [enclosingChunk("oversized", 0, 3, "x".repeat(100000)), enclosingChunk("small", 0, 3, "xxx")];
    const result = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "xxx", chunks), ["IMPORTANT_CALLER", "RELEVANT_TEST"]);
    fits(result);
    assert.match(result.messages[1].content, /Symbol: small/);
    assert.match(result.messages[1].content, /IMPORTANT_CALLER/);
    assert.ok(result.messages[1].content.indexOf("IMPORTANT_CALLER") < result.messages[1].content.indexOf("RELEVANT_TEST"));
  });

  test("unused repository allowance can admit enclosing snippets larger than half the remainder", () => {
    const patch = hunk(1);
    const baseline = build([file("f.ts", patch)]);
    const remaining = baseline.reviewInput.budget.contextTokens - baseline.reviewInput.budget.outputTokens
      - baseline.reviewInput.budget.safetyTokens - baseline.reviewInput.budget.estimatedInputTokens;
    const chunk = enclosingChunk("large", 0, 3, "xxx" + "x".repeat(Math.floor(remaining * 0.65)));
    const result = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "xxx", [chunk]));
    assert.match(result.messages[1].content, /Symbol: large/);
    fits(result);
  });

  test("redistribution preserves retrieval rank and a large enclosing file cannot consume the caller allowance", () => {
    const patch = hunk(1);
    const baseline = build([file("f.ts", patch)]);
    const remaining = baseline.reviewInput.budget.contextTokens - baseline.reviewInput.budget.outputTokens
      - baseline.reviewInput.budget.safetyTokens - baseline.reviewInput.budget.estimatedInputTokens;
    const large = "FIRST_CALLER" + "x".repeat(Math.floor(remaining * 0.60));
    const ranked = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "xxx", []), [large, "SECOND_TEST"]);
    assert.ok(ranked.messages[1].content.indexOf("FIRST_CALLER") < ranked.messages[1].content.indexOf("SECOND_TEST"));
    assert.match(ranked.messages[1].content, /FIRST_CALLER/);
    const chunks = Array.from({ length: 8 }, (_, i) => enclosingChunk("enclosing" + i, 0, 3, "xxx" + "x".repeat(Math.floor(remaining / 5))));
    const shared = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "xxx", chunks), ["IMPORTANT_CALLER" + "x".repeat(Math.floor(remaining / 3))]);
    assert.match(shared.messages[1].content, /IMPORTANT_CALLER/);
    fits(ranked);
    fits(shared);
  });

  test("several files receive useful enclosing candidates while callers retain space", () => {
    const patch = hunk(1); const filenames = ["a.ts", "b.ts", "c.ts"];
    const context: ChangedCodeContext = { headSha: "head", fullyHeadCoveredFiles: [], files: filenames.flatMap((name) =>
      changedContext(name, patch, "xxx", [enclosingChunk(name, 0, 3, "xxx")]).files) };
    const result = buildWithEnclosing(filenames.map((name) => file(name, patch)), context, ["CALLER"]);
    assert.ok(result.reviewInput.files.every((entry) => entry.enclosing?.status === "complete"));
    assert.match(result.messages[1].content, /CALLER/);
  });

  test("structural hints survive but synthetic content cannot prove coverage", () => {
    const patch = hunk(1);
    const chunk = { ...enclosingChunk("split", 0, 3, "xxx"), split: true, structuralContext: "// Signature: function f()\n// Context: if (authorized)" };
    const result = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "xxx", [chunk]));
    assert.match(result.messages[1].content, /if \(authorized\)/);
    assert.equal(result.reviewInput.files[0].enclosing?.split, true);
    const synthetic = { ...chunk, symbolType: "class_skeleton", sourceSpans: [] };
    const skeletonResult = buildWithEnclosing([file("f.ts", patch)], changedContext("f.ts", patch, "xxx", [synthetic]));
    assert.equal(skeletonResult.reviewInput.files[0].enclosing?.status, "partial");
    fits(skeletonResult);
  });

  test("fallback reasons and metadata-only changes remain explicit", () => {
    const patch = hunk(1);
    const context: ChangedCodeContext = { headSha: "head", fullyHeadCoveredFiles: [], files: [{ filename: "f.ts", coverage: "fallback:over-file-cap", chunks: [], unmapped: [] }] };
    const result = buildWithEnclosing([file("f.ts", patch), { filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 0, deletions: 0 }], context);
    assert.equal(result.reviewInput.files[0].enclosing?.reason, "over-file-cap");
    assert.equal(result.reviewInput.files[1].enclosing?.status, "not-applicable");
  });
});
