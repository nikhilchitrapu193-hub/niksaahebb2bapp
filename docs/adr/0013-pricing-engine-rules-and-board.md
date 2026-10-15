# 0013 — Prices come from a formula in the database, mirrored in the browser
**Status:** Accepted

**Context.** Until now `products.price` was a number someone typed, `market_price` another, and the
margin lived in the admin's head. The build list wants every price to come from a visible formula
(cost + wastage + delivery + margin), benchmarked against market rates, with history, a margin guard,
scheduled changes and HSN codes. The choices were: compute in the browser only (simple, but two admins
could publish different numbers and nothing could be audited), compute in an Edge Function (another
runtime to deploy and secure), or compute in SQL.

**Decision.**
1. **One pure SQL function, `compute_price_from(jsonb)`,** does the arithmetic. `pricing_inputs()`
   gathers the merged variables (product override → category rule → global rule) plus costs and the
   benchmark; `apply_prices()` recomputes server-side before writing. The browser keeps a line-for-line
   copy in `web/js/core/pricing.js` for instant previews, and both are tested on the same numbers
   (`security_test.sql` T30 ↔ `tests/unit.test.js`).
2. **Rules per category with effective dates, overrides per product.** `pricing_rules` keeps old rows
   (the one in force on a date wins) so a change can be prepared ahead and old prices explained.
   `product_pricing` overrides any variable or switches the mode (`rule`, `fixed_over_benchmark`,
   `manual`); yield % lives there because dressing loss is per product.
3. **Costs from the ledger.** `stock_movements.unit_cost` on receipts gives the latest cost and a
   30-day weighted average (`v_product_cost`); today's supplier quote fills the gap before stock arrives.
   No new cost table.
4. **Benchmarks are rows, not fields.** `benchmark_prices` is one rate per source, product and day,
   entered by hand or uploaded as CSV; the Phase 3 fetcher will write the same table. Customers see the
   chosen benchmark as `market_price` with a label and date.
5. **Costing data is staff-only.** Every new table has RLS on the `pricing` permission module and no
   `anon` grant. Order lines keep their landed cost in `order_line_costs`, not on `order_items`
   (which customers read). `products` gains only safe columns.
6. **Scheduled prices** are rows in `scheduled_prices`; `publish_due_prices()` applies due ones from a
   pg_cron job every five minutes where the extension is enabled, and whenever the board opens.
7. **Margin guard** is a rule setting: `warn` makes publishing below cost or under the minimum markup
   need an explicit "publish anyway"; `block` refuses.

**Consequences.**
+ A CA can trace any invoice price to its cost, rule, benchmark and the person who published it
  (`price_history.rule_snapshot`).
+ Margin reports (batch 9) read `order_line_costs`, so a later rule change never rewrites history.
+ Two copies of the formula to keep in step — mitigated by the shared fixtures; the SQL copy is the one
  that writes.
− `pricing_inputs()` runs one query set per product; the board for a few hundred products is fine,
  thousands would want a single set-based query (`shortcut: per-product function, revisit above ~2,000 active products`).
− Price lists per city or sector and contract rates are not here; they will add a layer on top of the
  published price rather than change the formula (see `docs/build-roadmap.md`).
