# Parcel Shop Q&A evaluation

This evaluates the real repository Q&A path at frozen commit
`48f9459610c1a9735e4b5cfb651994dd769e61bd`. It creates no chat sessions,
messages, review records, queues, tables, or GitHub changes. Ground truth lives
here, outside the indexed Parcel Shop repository. The production model is
**Gemini `gemini-3.1-flash-lite`**, at temperature 0.2. Production repository Q&A
and the CLI share `repositoryQALLM` from llm.service.ts. The saved Ollama
`qwen2.5-coder:7b` baselines remain unchanged for comparison.

## Commands

Run these in `backend/` (PowerShell users can use `npm.cmd`). Existing PostgreSQL,
both Redis instances, the indexed repository, production embedding credentials,
Clerk/DB environment configuration and `GEMINI_API_KEY` are needed
for `run`. `score` and `compare` are offline and do not import application
services, read `.env`, call a model, or change the saved raw answers.

```powershell
# Recheck source/test ground truth, without modifying the benchmark checkout:
npm.cmd run eval:qa:verify -- "C:\Users\aravi\OneDrive\Desktop\coding\evaluation-test-repo\parcel-shop-benchmark"

# Use a NEW label. Existing output folders cannot be overwritten.
npm.cmd run eval:qa -- run experiment-01 --repository-id 03f9b738-c41a-4fc9-9adc-1514a97971bc

# Edit experiment-01/adjudications.json, then score saved outputs:
npm.cmd run eval:qa -- score experiment-01
npm.cmd run eval:qa -- compare baseline-02 experiment-01

npm.cmd run eval:qa:test
npm.cmd run eval:qa:check
```

`--clerk-user-id` can disambiguate multiple owned imports. This is a local trusted
operator CLI: it resolves the DB-mapped owner and verifies repository ownership,
not an unauthenticated HTTP endpoint. It never accepts OAuth tokens in fixtures.
It uses read-only readiness checks against the prevalidated index and never
requests a sync. Do not reindex or update the benchmark during a run.

## Ten cases and independent verification

| Case | Behavior being checked |
|---|---|
| quantity-validation | Positive safe integers; invalid/excess quantities leave stock unchanged |
| shipping-boundary | 7499/7500-cent shipping boundary and totals |
| reservation-deadline | Injected clock plus 900000-ms lifetime gives 901000 |
| expiration-cleanup | Lazy cleanup at the inclusive boundary; all three entry points; one release |
| checkout-totals | Reservation → catalog → order lines → pricing across files |
| repeated-checkout | Single-use checkout; checked-out stock does not later return |
| returned-copy | Primitive-field mutation of returned copy cannot alter stored state |
| environment-configuration | No lifetime environment variable at this revision |
| inventory-persistence | Fresh processes cannot recover stock reductions or reservation IDs |
| conversational-followup | Fixed prior turns; production anaphoric query expansion; release guard |

`verify.mjs` extracts tracked files with `git show` at the exact frozen SHA, checks
every declared source fragment and runs `behavior.test.mjs` plus the original
Parcel Shop tests. `verification.json` records the source inventory/content,
hashes, test implementation hashes, TAP results, timestamp and Node version.
The private tests assert independent observable results, not model answers or
the evaluator's scoring logic. For the negative cases, inspect all source
modules and `package.json` as well as the fresh-process tests: sampling candidate
environment variables alone is not a universal proof of nonexistence. Absence
of a retrieved file never establishes absence of a capability.

## Production path and instrumentation

1. `chat.service.ts` still resolves the provider, saves the user message and
   fetches the latest **10 messages**, reversing them to oldest-first. It still
   saves the assistant response, updates timestamps and runs the after-hook.
2. `chatGeneration.ts::generateChatResponse()` contains only the shared middle:
   provider context, source/metadata events, unchanged system + ordered history,
   production stream and response assembly. Evaluation passes a synthetic
   in-memory session and fixed history to that same function. It bypasses all
   persistence, not the provider or model. Failure semantics are unchanged.
3. `RepositoryContextProvider` invokes the unchanged `retrieveQAContext()`.
   An optional observer captures returned code/docs/profile/graph/query and
   timing (`qa.retrieved`), then actual prompt selection (`qa.budgeted`).
4. `qa.request` records the exact LLM messages and source snapshot.
   `qa.usage` records provider-reported terminal input/output counts and available
   provider durations. `qa.response` records generated text, first-text and
   generation timing. Raw partial text survives failed CLI runs.
5. Index READY state, frozen revision, all chunk revisions and content/graph
   fingerprints are checked before/after each case. A revision mismatch is an
   invalid benchmark, not a retrieval/answer-quality failure.

Observers receive defensive clones, cannot change prompts/rankings and are
optional. The user-authorized Gemini switch changes the generation adapter and
adds streaming retries; Q&A prompt wording, retrieval thresholds and budgets
remain unchanged. Transient HTTP 500/502/503/504 errors before the first emitted
text get at most five total attempts with 1/2/4/8-second waits. SDK nested retries
are disabled. Partial streams are never replayed, avoiding duplicated text;
authentication, quota and validation errors are not retried. Existing Q&A character caps remain overview 1200/500,
docs 1200 each and 3000/1200 per section, code 1500 each and 6000/2500 per
section, imports 3000 each. There is no provider tokenizer budget estimate in
this Q&A path: the evaluator reports characters separately and leaves token
estimates unknown. Actual tokens come from provider usage metadata. Gemini cumulative chunks are
not summed; thinking tokens and returned model version are retained separately.
Failed-attempt usage remains unknown. `generationAttempt` events record retry
status and wait times, which are included in overall latency.

## Retrieval and answer quality are independent

The QA retrieval observation is **after SQL similarity thresholds and result
limits**, before prompt section selection/truncation. It does not claim to
observe every vector-search candidate, and it has no PR-head verification stage.
Requirements match exact repository-relative path, frozen revision and source
fragments (whitespace-normalized; leading function `export` wrappers are
normalized because the AST stores them separately from function bodies).
Path mentions, repository profiles, import
lists and synthetic class skeletons do not count as executable source evidence.

Coverage is reported per evidence group and fragment at retrieval and in the
actual system prompt. Indicators distinguish missing returned evidence from
evidence dropped during prompt selection/budgeting. Only a finalized
incorrect/incomplete answer with all declared evidence present gets the
"incorrect despite evidence" indicator. These are diagnostics, **not causal
proof**: the manually declared evidence may itself be incomplete, and the
server may apply model-side truncation not exposed by the API. Saved request
evidence proves what was submitted, not model attention or internal retention.

## Adjudication

Open the run's `summary.md` for expected-versus-actual answers, then inspect
`<case>.json` for the exact numbered citation bodies and prompt. All generated
adjudications initially have `humanConfirmed: false` and unresolved verdicts.
Optional `proposedClassification` notes are explicitly provisional and **never
contribute to metrics**. Do not mark confirmation without checking the source,
targeted tests and answer yourself.

For each case in `adjudications.json`:

- `facts`: mark each required fact `correct`, `incorrect` or `missing`, with
  a short evidence note. Use `correct` only when the answer conveys the whole
  fact (equivalent wording is fine); `missing` covers omitted/incomplete
  information; `incorrect` covers a conflicting assertion.
- `additionalFactualErrors`: `none` or `present`; check extra claims, not just
  the expected checklist. This prevents a correct headline with invented
  explanations from being called fully factually correct.
- `grounding`: `supported`, `partial`, `unsupported`, or `not-applicable`.
  Check whether substantive answer claims are justified by the **submitted
  prompt evidence**, independent of which citations the answer chose.
- `citations`: for each extracted numeric `[n]` occurrence, mark `supported`
  or `unsupported`, with a note relating the associated claim to that exact
  numbered excerpt. An existing ID is not proof of support. An unresolved ID
  cannot be marked supported. The parser recognizes `[1]`, `[1][2]`, and
  `[1, 2]`; other citation syntax needs manual inspection and a note.
- `citationCompleteness`: the same four labels as grounding, assessing whether
  substantive source-dependent claims have supporting citations. Missing
  citations do not make facts incorrect. With no citations, citation-support
  precision is **null**, while completeness can be `unsupported`.
- Supply `reviewer`, case `notes`, set `groundTruthConfirmed: true`, then
  `humanConfirmed: true`. Unresolved dimensions or missing notes reject scoring.

For explicitly user-authorized agent review, set `agentConfirmed: true`, keep
`humanConfirmed: false`, and identify the agent in `reviewer`. Ground-truth
verification, resolved judgments and evidence notes remain mandatory. Reports
label this agent-adjudicated; it never implies human verification. Both flags
cannot be true. New runs default to neither being confirmed.

Scores are computed on finalized completed cases only, with separate human/agent counts
and pending count shown. Factual coverage is correct expected facts / expected
facts. Fully factual answers require every expected fact plus no additional
factual errors. Fully grounded rate counts `supported` among applicable answers;
partial grounding stays separately visible per case. Citation support is
supported occurrences / all numeric citation occurrences. Zero denominators
stay null. There is no combined score that hides differences between these
dimensions. For example, correct shipping arithmetic with a wrong citation can
have full factual credit and zero citation support.

## Files and artifacts

Versioned code/data:

- `evalQA.ts`: run/score/compare, preflight, frozen-index checks, local artifacts.
- `qa-eval/cases.json`: questions, fixed conversation, expected facts and evidence.
- `qa-eval/evaluation.ts`: source coverage, citation IDs, confirmation validation,
  separate metrics and readable reports.
- `qa-eval/verify.mjs`, `behavior.test.mjs`, `verification.json`: independently
  executable and inspectable ground-truth evidence.
- Focused tests cover production write/stream order, unchanged adapter requests,
  observer isolation, source truncation, frozen retrieval, scoring and drift.

Generated, Git-ignored output is in `backend/scripts/qa-eval-out/<label>/`:

- `run.json`: CodePilot commit/dirty state, source/config/parser and lockfile
  hashes, machine/model digest/settings, frozen index fingerprint and cache policy.
- `manifest.json`, `verification.json`: immutable run-local dataset/proof copies.
- `<case>.json`: actual answer, exact messages, all observations, source bodies,
  timings, actual usage and failure details. No credentials or vectors are saved.
- `adjudications.json`: the editable adjudication form, bound to artifact hashes.
- `summary.json`, `summary.md`: regenerated offline, including expected/actual text.
- `compare-<baseline>.json/.md`: offline comparison; JSON includes per-case
  answers, coverage, verdicts, timing and usage. Different dataset/index states
  are rejected; semantic deltas require identical finalized case subsets.

The first smoke baseline is `baseline-01`; `baseline-02` is the final verified
Ollama implementation run; `gemini-01` is the separate Gemini run. These are real model executions from this implementation
pass; neither is a mock or a scored ground-truth substitute.

Model sampling, hardware load, model defaults and warm embedding/profile caches
can change outputs and timings. One ten-question repository benchmark supports
case studies and regression checks, not general quality claims or statistically
significant model comparisons. No costs are invented, and indexing/setup costs
are kept outside review execution. The harness creates no new index entries,
but ordinary production embedding/profile caches can be populated.
