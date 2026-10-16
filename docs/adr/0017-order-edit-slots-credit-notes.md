# 0017 — One order core for place / edit / on-behalf; slots gate ordering; issues raise credit notes
**Status:** Accepted

**Context.** Batch 6 adds editing an order, placing one for a customer, slot cut-offs and capacity, clearer
cancellation, and a report-an-issue flow. `place_order` had already been revised four times (v2–v5); editing
and order-on-behalf would each have duplicated its line-and-total logic, and the "allow ordering beyond stock"
question from ADR 0007 was still open.

**Decision.**
1. **One shared order core.** `rebuild_order_lines()` reserves stock, prices and cost-snapshots every line of
   an order, returning any stock the current lines held first. `place_order_core()` wraps it with the header,
   delivery fee, MOV check and status history. Three thin entry points reuse it: `place_order` v6 (the
   customer, obeying the cut-off), `place_order_for` (staff, orders:edit, may place late) and `edit_order`
   (rebuild an existing order). No logic is duplicated; v5 is kept as `place_order_v5_legacy` (no DROP).
2. **Editing returns and re-reserves stock.** `edit_order` runs the same core, so an edit is a clean
   cancel-and-replace of the lines: the old reservations go back (`order_cancelled`), the new ones are taken
   (`order`). Two honest ledger rows per changed product beat a silent in-place adjustment. A customer may edit
   only while the order is `placed` and before its cut-off; staff may edit until it is `packed`.
3. **Slots gate ordering, by config, not in code.** `slot_config` carries a cut-off hour and an optional
   capacity per city + slot; `slot_open()` enforces both. **No row means always open**, so ordering behaves
   exactly as before until an admin sets cut-offs — and the security suite clears any seeded config so order
   totals stay deterministic regardless of the wall clock. Staff ordering on behalf bypass the cut-off.
4. **"Order beyond stock" stays off.** The open question from ADR 0007 is answered for Phase 1: orders still
   cannot exceed free stock (`rebuild_order_lines` keeps `place_order`'s availability check). Buy-to-order is a
   setting for a later batch; nothing here depends on changing it.
5. **Issues raise credit notes; applying them is batch 7.** `report_issue` opens an `order_issues` row;
   `resolve_issue` (orders:edit) resolves or declines it and may raise a `credit_notes` row (capped at the
   order total). A credit note is a recorded liability here; applying it to the account balance or an invoice
   is Payments & credit (batch 7), which reads this table.

**Consequences.**
+ Edit, order-on-behalf and place share one tested code path and one set of rules.
+ Slot cut-offs and capacity are admin-tunable per city without a deploy, and dark by default.
+ Credit notes give batch 7 a clean input; support can close the loop with the customer now.
− `edit_order` and `rebuild_order_lines` contain row-removal statements, so migration 013 must be applied from
  the Supabase SQL editor (the MCP migration tool refuses them) — see `docs/deployment.md`.
− A credit note is not yet money back; until batch 7 it is a record the customer and finance can both see.
