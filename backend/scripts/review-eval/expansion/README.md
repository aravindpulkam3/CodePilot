# Nine additional local benchmark scenarios

Publication is complete: the nine new cases are PRs #4 through #12. Use
`cases-v2.json` for the full 12-case evaluation; `cases-v2.draft.json` preserves
the pre-publication checkpoint. See [published-prs.md](published-prs.md) for links.

From `backend/`, run:

```powershell
npm.cmd run eval:review -- run expanded-01 --manifest scripts/review-eval/expansion/cases-v2.json
```

The local preparation and publication instructions below document how these
fixtures were created. Do not merge the benchmark PRs or change their frozen heads.

These extend the three pilots to 12 cases: three simple bugs, five cross-file bugs,
and four safe changes in total. They use the same base commit and existing shop
contracts. No new dependencies, production reviewer changes or GitHub writes.

The actual branches live in:

`C:\Users\aravi\OneDrive\Desktop\coding\evaluation-test-repo\parcel-shop-benchmark`

Private patches, full TAP logs, scratch snapshots and proposed PR text live beside
that repository in `benchmark-verification/expansion-v2/`. Never copy this directory
or these private definitions/tests into the benchmark: they expose the expected bugs.

## Reproduce locally

From CodePilot's backend directory:

```powershell
node scripts/review-eval/expansion/prepare.mjs `
  "C:\Users\aravi\OneDrive\Desktop\coding\evaluation-test-repo\parcel-shop-benchmark" `
  "C:\Users\aravi\OneDrive\Desktop\coding\evaluation-test-repo\benchmark-verification\expansion-v2" `
  scripts/review-eval/cases.json
```

This executes 10 existing application tests and nine private behavioral tests on
the base, every new head, and all six minimally corrected bug heads. Existing
public tests remain untouched; their expected head failures are explicitly checked.
The private suite includes all 25 supported product/quantity combinations, 36
two-line pricing combinations, empty input, exact expiry and shipping boundaries,
duplicate catalog IDs, instance isolation and reservation lifecycle checks.

All tests must match their expected results before branches are created. The script
uses a private Git index and does not switch the checkout or modify main. Existing
branches must have the expected tree and base parent; differing branches are never
overwritten. It makes no network or model calls. Reruns refresh the verification
report and create a fresh scratch directory; preserve prior reports separately if
needed. Branch revisions stay fixed on reruns.

`scenarios.mjs` defines exact source edits, independent expected behavior, context
requirements and expected test failures. `behavior.test.mjs` is the external oracle.
`prepare.mjs` prepares snapshots, checks base/head/correction behavior, creates
branches, exports patches and produces the draft manifest. Corrected snapshots
are private verification only, not proposed PR branches.

## Manifest and publication

`cases-v2.draft.json` is a versioned draft containing the unchanged three pilots
and nine frozen local heads. New cases have `pullNumber: null` and
`snapshotHash: null`: they have no GitHub PR yet. The current CLI intentionally
rejects this draft. It must not be used as if a 12-case evaluation has occurred.

After reviewing the local patches and results:

1. Publish only the nine branch refs, then create PRs targeting unchanged main.
   Use the neutral titles and descriptions in `proposed-prs.md`; do not publish
   ground truth, failing-oracle explanations or corrected snapshots.
2. Obtain the actual PR numbers and live paginated snapshots. Confirm each base
   and head matches the draft; calculate snapshotHash with the existing evaluator
   helper from those live payloads, including the actual title/body and file order.
   Do not estimate PR numbers or synthesize a GitHub snapshot hash from a local diff.
3. Save a runnable `cases-v2.json`, mark it published, and validate it with
   `validateManifest()`. Keep `cases.json` (v1) and earlier artifacts unchanged.
4. Run `npm.cmd run eval:review -- run expanded-01 --manifest scripts/review-eval/expansion/cases-v2.json`.
   The expected base index is unchanged, so no new indexing is needed if it is
   still READY at that SHA. Judge results and compare only runs of the same dataset.

## Scope and limits

All six defects have concrete contracts and reproducible failures. Some already
fail existing public tests; that is documented, not hidden. These cases measure
review detection, not defects that evade CI. Public PR text contains no expected
bug labels. Ground truth is executable-test-backed and source-inspected by Codex,
not independently human-reviewed.

This small repository offers modest retrieval difficulty. The four new cross-file
cases exercise producer/consumer units, receipt shape, clock forwarding and stock
release contracts. Required fragments exist at both the indexed base and the PR
head. The selected locations are outside the changed file, allowing four-stage
coverage checks. They do not prove the model needed retrieval rather than inferring
the bug from the diff alone.

No artificially padded large-diff case is included. Prompt-budget stress and
multi-issue cases remain separate future additions; these 12 cases do not claim
to exhaust reviewer quality or retrieval performance.
