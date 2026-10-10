# Local expansion verification

All heads are independent children of the frozen base. No GitHub PRs were created.

| Case | Type | Head application | Head private checks | Corrected application/private |
| --- | --- | --- | --- | --- |
| delivery-threshold | simple-bug | 8/10 | 6/9 | 10/10; 9/9 |
| line-amounts | simple-bug | 9/10 | 7/9 | 10/10; 9/9 |
| stock-replenishment | cross-file-bug | 9/10 | 6/9 | 10/10; 9/9 |
| shop-clock | cross-file-bug | 9/10 | 7/9 | 10/10; 9/9 |
| checkout-units | cross-file-bug | 7/10 | 7/9 | 10/10; 9/9 |
| catalog-amounts | cross-file-bug | 8/10 | 7/9 | 10/10; 9/9 |
| inventory-initialization | safe-change | 10/10 | 9/9 | safe: no correction |
| checkout-line-helper | safe-change | 10/10 | 9/9 | safe: no correction |
| reservation-sweep | safe-change | 10/10 | 9/9 | safe: no correction |

Bug-head failures are intentional, with exact failure names checked. Existing public tests were not altered or hidden. Base and all corrections pass. Private generated-basket checks exercise 36 two-line combinations plus empty input.
