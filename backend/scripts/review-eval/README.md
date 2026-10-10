# PR review evaluation

Gemini structured generation now retries HTTP 500/502/503/504 errors for at most
five total attempts, waiting 1, 2, 4 and 8 seconds between attempts. Production and
evaluation share this adapter behavior (other structured Gemini callers use it too).
Only the provider request is retried; acquisition/retrieval and successful outputs
are not rerun. Metadata preflight is not retried by this generation policy.
Authentication, quota/rate-limit (429), invalid output and validation errors are
not retried. Exhausted cases remain failed and the runner proceeds to the next case.
The SDK's nested retries are disabled for these requests to enforce the limit.
Artifacts record `generationAttempt` events and reports show attempt counts/waits.
Generation and overall latency include waits; usage describes the returned response,
while usage/cost of failed attempts is unknown. Older runs lack attempt diagnostics.

The nine additional scenarios are now published as PRs #4 through #12. Use
`--manifest scripts/review-eval/expansion/cases-v2.json` to evaluate all 12 cases.
See [expansion/README.md](expansion/README.md) and [expansion/CASES.md](expansion/CASES.md).
The default `cases.json` still selects the original three pilots; the version-2
draft is retained only as a pre-publication checkpoint.

Run from `backend/`. No additional dependency or database migration is required.
This CLI evaluates the production Gemini reviewer against the three frozen Parcel
Shop PRs. It does not insert reviews/findings, change latest-review flags, enqueue
indexing, or start workers. Source, prompts and model output are saved locally
under the gitignored `scripts/review-eval-out/` directory.

```powershell
npm run eval:review -- run baseline-03
npm run eval:review -- score baseline-03
npm run eval:review -- compare baseline-03 experiment-01
```

Use `npm.cmd` on Windows if PowerShell blocks `npm.ps1`. Each `run` needs a new
label; previous runs are never overwritten. `score` and `compare` read saved JSON
only, work with services stopped, and make no GitHub, database, embedding, or
generation calls. They regenerate JSON and Markdown reports.

## Before running

- Keep benchmark `main` at `48f9459610c1a9735e4b5cfb651994dd769e61bd`, with PRs
  #1, #2 and #3 open and their branches unchanged.
- The benchmark must already be indexed in CodePilot. Stop interacting with its
  sync/start-working controls during an evaluation. The CLI requires READY,
  the expected row/chunk revision, and an unchanged index fingerprint/run ID
  before and after each review. These checks do not create database snapshot
  isolation; keep this small benchmark index idle.
- PostgreSQL, cache Redis (6379), coordination Redis (6380), and Gemini API access must
  be available. Workers are not needed after indexing, but current module imports
  create queue connections, so both Redis endpoints are still required.
- Use the normal backend environment: `DATABASE_URL`, Clerk publishable/secret
  keys, and Google's embedding credentials as configured for CodePilot. PR reads
  use the owning user's GitHub OAuth token through Clerk, including public PRs.
- Set `GEMINI_API_KEY` for the production Gemini adapter (`gemini-3.6-flash`).
  The CLI records the model, provider, context budget and actual request settings.
  Existing `baseline-02` artifacts retain their original Ollama results; a new
  run is required to measure Gemini.

The trusted local CLI resolves the benchmark row and its owner together in the
database, calls `findOwnedRepositoryById`, and uses that owner's Clerk identity.
It is not a new remotely accessible endpoint. If multiple users indexed the same
repository, select the intended owned index explicitly:

```powershell
npm run eval:review -- run baseline-03 --repository-id REPOSITORY_UUID --clerk-user-id CLERK_USER_ID
```

Credentials and tokens are never read from the dataset or written to artifacts.
Expected findings are used only by offline scoring, never inserted into prompts.

## Files in a run

| File | Contents |
| --- | --- |
| `run.json` | Dataset hash, CodePilot commit/dirty flag and source hash, dependency hash, machine/model/index configuration, cache policy, preflight failure if any |
| `manifest.json` | Frozen copy of the dataset |
| `<case-id>.json` | PR snapshot, all evidence stages, exact messages/schema, raw provider response, validated findings, timings, usage, index checks and errors |
| `adjudications.json` | Editable classifications; starts unresolved and unconfirmed |
| `summary.json`, `summary.md` | Per-case and aggregate metrics, context coverage, findings and performance |
| `comparison.json`, `comparison.md` | Created by `compare`; metrics, evidence changes, missed/recovered bugs and resource deltas |

Preflight failures and generation errors are saved as failed cases with nonzero
process exit status. PR/index drift produces invalid cases. Failed/invalid cases
hold aggregate quality metrics pending; they never count as clean reviews. Raw
provider text and usage are captured before parsing, so malformed responses can
be inspected. If a provider fails before responding, those fields stay unknown.

## Manual adjudication

Inspect each case's `validated` event, the exact prompt, and the expectations in
`manifest.json`. Finding `f1` is validated findings array element 0, `f2` is element
1, and so on. The raw response is diagnostic; quality metrics describe the
validated findings a user would actually receive.

Edit the matching entries in `adjudications.json`. Set the top-level `reviewer`
to your name or identifier. For a true match:

```json
{
  "findingId": "f1",
  "disposition": "matched",
  "expectedBugId": "stock-allocation-B1",
  "duplicateOf": null,
  "rootCauseConfirmed": true,
  "triggerOrConsequenceConfirmed": true,
  "locationConfirmed": true,
  "notes": "The finding identifies rejection of equality and explains why buying the remaining stock fails."
}
```

Use these dispositions:

| Value | Meaning |
| --- | --- |
| `matched` | Correct expected bug, with root cause, trigger/consequence and acceptable location confirmed |
| `false_positive` | A concrete incorrect defect allegation; explain why the code is safe |
| `duplicate` | Repeats another resolved finding; set `duplicateOf` to that finding ID |
| `valid_unexpected` | Independently verified real defect absent from current ground truth; holds final metrics pending until the dataset is corrected |
| `non_bug` | Style advice, praise or another observation that does not allege a defect |
| `unresolved` | Still needs review |

Every final classification requires notes. One expected bug can receive credit
only once. Classify other findings about the same root cause as duplicates rather
than another match. A duplicate must reference a resolved nonduplicate finding.
Matching checks acceptable paths but never requires exact prose or exact model
line numbers; production can normalize anchors to file-level locations.

Set each case's `confirmed` to `true` after reviewing all its findings. Confirm
zero-finding cases too: this records a deliberate check of misses or a clean safe
change. Do not modify `artifactHash`, run/dataset IDs, or raw case artifacts.
Then run `score`. It detects stale adjudications and never calls the model.

TP is the number of distinct expected bugs matched, FP counts confirmed false
defect claims, and FN is the unmatched verified bugs. Precision is TP/(TP+FP),
recall TP/(TP+FN), and F1 2TP/(2TP+FP+FN). A zero denominator is null. Duplicate and
non-bug counts are separate. Safe cases have separate false-alarm counts.
Whole-suite metrics are pooled counts, and remain pending until every case is
complete and finalized. Bugs in omitted changes remain in the recall denominator.

Never classify an unexpected finding as false merely because the manifest omitted
it. Verify it with source/tests first. Update ground truth under a new dataset
version when necessary. Direct comparison rejects different dataset hashes; do
not silently edit the saved manifest to make a score improve.

## Evidence and missed-bug diagnosis

The same production path performs acquisition, retrieval, PR-head verification,
budgeting, generation, output validation and a final head/base check. Production
then publishes as before. Evaluation stops before publication.

| Stage | Capture point |
| --- | --- |
| `initial` | Actual SQL search results, before candidate merge, reranking and retrieval budget allocation; search thresholds and per-source caps have already applied |
| `selected` | Final retrieval output, with its existing counts, timings and dropped-candidate trace |
| `verified` | Candidates refreshed and reparsed at PR head, plus exclusion reasons |
| `prompt` | Actual code/doc indices and enclosing chunks accepted by the production prompt builder after its final budget |

Exact repository-relative paths and all required source fragments must match;
filenames in prose and synthetic chunk headers cannot satisfy a requirement.
Fragments can occur across several real snippets. Head-verification/final-prompt
checks require the PR-head SHA; synthetic class skeletons are not source coverage.
Enclosing code can satisfy final context even when retrieval missed it. Symbol
names are displayed as diagnostic hints; source fragments are decisive because
chunk names can change for split symbols or whole-file fallbacks.

Only the duration case currently has declared cross-file requirements. The other
two report n/a for cross-file retrieval, not an invented 100%. The duration case
is deliberately easy: the helper name also hints at units. It establishes that
the caller reached the model, not a challenging general retrieval benchmark.

For finalized misses, the report first checks whether the relevant changed hunk
was supplied, then identifies missing discovery, selection loss, head-verification
loss, or final budget loss. If all declared evidence was present, it reports
`missed_despite_declared_evidence_present`. This is a useful investigation lead,
not proof of a reasoning defect or proof that the ground-truth context list was
exhaustive. Inspect the saved prompt and source before drawing that conclusion.

## Timing, usage and cost

Per-case wall time includes acquisition through validated generation/final
revision check plus the evaluator's index checks. Service events separately record
acquisition, preparation, generation and validation/revision time. Retrieval's
existing substage trace is also saved. Setup, initial indexing, normal database
publication, and human scoring are excluded.

Provider input/output counts are measured usage when returned; null means unknown.
`reviewInput.budget.estimatedInputTokens` uses conservative UTF-8 bytes and must
not be interpreted as billing tokens. Ollama's detailed durations are nanoseconds.

Local Ollama has zero generation API charges; hardware/electricity are unmeasured.
Gemini query embeddings are still used. Their cost and initial indexing cost are
unmeasured, so total pipeline cost stays null. Hosted usage can be priced only
with an explicitly supplied `--pricing FILE` containing model, USD rates per
million tokens, effective date and source URL. No current prices are invented.
The simple supported billing mode is `uncached-text-no-thinking`; cached/thinking
usage remains unpriced rather than incorrectly applying a flat rate. Version one
uses the production default Ollama model; there is no evaluation-only model switch.

Run one sequential pass initially. Caches are reused without flushing or warm-up;
the first case may include model load. Compare under the same conditions and
inspect warnings for changed model/index/budget/machine metadata. A single pass
does not establish statistical significance; selectively repeat ambiguous cases
in later work rather than claiming determinism from low temperature.

## Verification commands

```powershell
npx tsc --noEmit
npm run eval:review:check
npm run eval:review:test
node --import tsx --test src/features/review/*.test.ts src/infrastructure/retrieval/*.test.ts src/infrastructure/llm/requestBudget.test.ts
```

The production test runner does not include scripts, hence the separate evaluation
test/typecheck commands. No frontend, schema, migration, background worker, or
external judge was added. Pilot ground truth and its executed verification report
were copied from the separately maintained Phase 1 fixtures; no new bug labels
were generated for the dataset.
