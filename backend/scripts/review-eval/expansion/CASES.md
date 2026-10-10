# Proposed nine-case expansion

All branches are local, independent children of base
`48f9459610c1a9735e4b5cfb651994dd769e61bd`. The original three PRs remain unchanged.
This document contains ground truth and must not be published in benchmark PRs.

| Local branch suffix (all under refactor/) | Source change | Expected behavior / finding | Required cross-file source |
| --- | --- | --- | --- |
| delivery-threshold | pricing.js: ternary becomes a conditional with `> 7500` | Exactly 7500 must have free shipping; the head charges 499 | None beyond changed source |
| line-amounts | pricing.js: named line amount replaces accumulation | Two lines worth 3000 and 2700 must subtotal 5700; head keeps only 2700 | None beyond changed source |
| stock-replenishment | inventory.js: release writes the received quantity | Expiring a two-unit hold must restore six available units to eight; head resets them to two | reservations.js: expiry calls release with the reserved quantity |
| shop-clock | shop.js: names inventory before constructing reservations | Supplied clock must determine deadlines and expiry; head drops the callback | reservations.js: default Date.now, callback reads and deadline addition |
| checkout-units | reservations.js: explicit checkout receipt uses `units` | Shop expects `quantity`; head produces undefined order quantity and NaN totals | shop.js: receipt consumer; pricing.js: multiplication by quantity |
| catalog-amounts | shop.js: normalizes unit price by dividing by 100 | Catalog values are already cents; head undercharges by 100x | catalog.js: 1500-cent notebook; pricing.js: cents-based computation and threshold |
| inventory-initialization | inventory.js: Map construction becomes a loop | Safe: same values, order and last duplicate ID; empty input and instance isolation preserved | None declared |
| checkout-line-helper | shop.js: extract local order-line helper | Safe: same fresh object, quantity, cents and call order | None declared |
| reservation-sweep | reservations.js: cleanup conjunction becomes guard clauses | Safe: same expiry boundary, one-time release and checked-out behavior | None declared |

For exact diff lines, expected bug IDs, source fragments and frozen head SHAs, see
`cases-v2.draft.json`. For neutral PR text use the external `proposed-prs.md`.

## Evidence and interpretation

The base passes 10 existing application tests and nine private behavioral tests.
All three safe heads pass the same 19 checks. Each bug head fails a predefined set
of application/private checks; all six minimal corrections pass all 19.
See `verification.md` for the per-case counts and `verification.json` for exact
failures, correction edits, TAP hashes, runtime and oracle fingerprint.

The tests check observable results, not whether the implementation contains the
expected operator or identifier. Corrections retain the surrounding refactor and
repair the actual contract. The existing public tests are intentionally untouched.

Coverage is defined before any model execution. For each cross-file requirement,
all source fragments were checked against both base and head snapshots. The live
evaluation will determine whether they are discovered, selected, head-verified and
included in the final prompt. There are no model quality results for these nine
cases yet, and no prediction of successful detection is made.

This remains a small repository benchmark; it is not a large-diff budget stress
test, a hidden-test challenge, or independent human ground-truth certification.
