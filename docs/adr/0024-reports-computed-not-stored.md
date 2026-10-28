# 0024 — Reports are computed on request, not stored as aggregates
**Status:** Accepted

**Context.** Batch 10 adds sales reports (six groupings over a date range), a receivables trend by week, and a
city-filtered dashboard. The usual choices are (a) query the transactional tables on request, (b) maintain summary
tables by trigger, or (c) a nightly job that fills a reporting table.

**Decision.** (a), with the functions written so that (c) can be added later without touching the screens.
`sales_report()`, `receivables_trend()` and `admin_dashboard_stats()` are `security definer` functions that apply
`in_my_scope` and the `reports:view` permission and return JSON rows; the browser renders and exports what it gets.
The receivables trend is computed "as at" each week's end from `delivered_at`, `due_date` and `payment_allocations.
created_at`, so the history is reconstructed from facts rather than from snapshots that could have been taken wrongly.

**Why.**
* Phase 1 volumes are small (hundreds of orders a day). Summary tables would add triggers on `orders`, `order_items`
  and `payment_allocations` — more code in the hottest write path — to save milliseconds nobody would notice.
* One source of truth: a report that is computed from the same rows as Payments and Orders cannot disagree with them.
  Stored aggregates drift the first time someone edits an order or voids a receipt and a trigger case is missed.
* Reversible: if a report ever gets slow, a nightly `daily_sales` table filled by the same SQL, and an index on
  `orders (created_at)`, slot in behind the same function signature.

**Consequences.**
+ No new write-path code; nothing to backfill; reports include an order the moment it is placed.
+ The trend is exact for any past week, including weeks before this batch shipped.
− A year-long customer-level report scans every order in the range; acceptable now, revisited when daily volume is in
  the thousands (the module doc names the two steps).
− "Sales" means order value as the order row stands today (edits are in place); invoiced / delivered views with GST
  summaries arrive with the finance batch (P2-6).
