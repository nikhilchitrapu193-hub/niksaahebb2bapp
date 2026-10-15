# 0007 — Stock is a ledger, not a number
**Status:** Accepted

**Context.** The warehouse needs stock on hand, receipts from suppliers, wastage and counts, and orders must not oversell.

**Decision.** `products.stock_qty` is a cached total that only the internal `apply_stock_movement()` function changes; every change is one row in `stock_movements` with a reason, reference (order or supplier), unit cost and author. `place_order()` locks each product row, checks availability and reserves stock in the same transaction; cancellation releases it. Admin screens call `receive_stock()` and `adjust_stock()`. *Since migration 011 (ADR 0015) receiving goes through `receive_goods()`, which writes a goods receipt and then the same ledger movement.*

**Consequences.**
+ Stock can always be explained and audited. Cost prices are captured on receipts for future margin reports.
+ Overselling is impossible even with concurrent orders (row lock).
− Admins cannot type a stock number into the product form; they use Adjust (deliberate).
− Batches/expiry and multiple warehouses are not modelled yet; both are natural extensions of the ledger (add `batch_id` / `warehouse_id` columns).
