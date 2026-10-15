# 0015 — One receipt path (GRN), purchase orders as the plan, buying list planned forward
**Status:** Accepted

**Context.** Batch 1 shipped "Receive stock": a form that added quantities to a warehouse with a supplier and
a cost, and nothing else. The build list asks for supplier rate cards, a buying list, purchase orders with
part-receipt and short-close, quality checks at the gate (accepted / rejected / grade) and mandi cash
purchases with a photo of the bill. Three questions had to be settled: whether receiving against a PO is a
*different* path from plain receiving, where the "what to buy" number comes from when orders already reserve
stock, and whether purchase orders should write stock themselves.

**Decision.**
1. **Every receipt is a goods receipt (GRN).** One function, `receive_goods()`, handles receipts against a
   PO, mandi cash purchases and direct deliveries (`source` = po / mandi / direct). One form in the browser
   (`grn.js` `receiveForm`) is opened from Purchase orders, Receipts and Inventory. The older
   `receive_stock()` stays in the database for compatibility and is no longer called. Stock still changes
   only through `apply_stock_movement()`; the movement carries the GRN number, supplier and unit cost, so the
   ledger and the price board's cost basis keep working without change.
2. **A purchase order is a plan, not a stock movement.** `purchase_orders` / `purchase_order_items` hold
   what was agreed (quantity, cost from the rate card unless typed); receipts update `qty_received` /
   `qty_rejected` on the lines and move the status (`sent → part_received → closed`). Short-close and cancel
   are explicit status changes. A PO never touches `stock_movements`; only receipts do.
3. **The buying list plans forward.** Because `place_order()` reserves stock at placement, "orders − stock"
   is never positive on the day. `buying_list()` therefore suggests
   `max(0, demand × days of cover + low-stock alert level − free stock − open PO quantity)`, rounded up to the
   supplier's MOQ in the browser. The arithmetic is mirrored in `web/js/core/procurement.js` (`suggestedBuy`)
   with shared test numbers (T45 ↔ `tests/unit.test.js`), the same way as the pricing formula.
4. **Rate cards are a table, not a column.** `supplier_products` holds price, MOQ, lead days and validity per
   supplier and product; a partial unique index keeps one preferred supplier per product. Suppliers'
   on-the-spot quotes typed on the price board (batch 2) stay as cost benchmarks — the rate card is the
   agreed price, the quote is market intelligence.
5. **Receiving stays an inventory permission; planning and ordering are a new `procurement` module.**
   `procurement:view` opens the buying list, POs, receipts and rate cards; `procurement:edit` creates and
   edits drafts, closes and cancels; `procurement:approve` sends a PO to the supplier; `inventory:edit`
   receives goods (the warehouse team receives, the buyer orders).

**Consequences.**
+ One set of validations for all receipts (reason for every rejection, bill amount on mandi purchases),
  one GRN number series, one place to add batch / expiry on receipt lines in batch 5.
+ POs give the three-way match (PO ↔ GRN ↔ supplier invoice) a foundation for the supplier payments batch.
+ The forward-looking buying list does not need the order flow to change; if the business later allows
  ordering beyond stock, the demand column already shows what to buy.
− The buying list's suggestion depends on alert levels being set per product; with all alert levels at
  zero and one day of cover it suggests nothing while stock covers tomorrow's orders. The screen says so.
− `inventory.js` now imports the receive form from `grn.js` (one module depending on another's form); the
  alternative — two receive forms — is the lapse rule 14 exists to prevent.
