# 0016 — Batches are an expiry overlay, trips carry the POD, cash is tracked per driver
**Status:** Accepted

**Context.** Batch 5 adds the order's journey after packing: expiry management, pick lists, trip sheets,
proof of delivery, doorstep returns and COD cash. The hard questions were how to track expiry without
rewriting the stock ledger, how an order moves to "out for delivery" as part of a trip, and where the cash a
driver collects lives.

**Decision.**
1. **Stock batches are an expiry overlay, not a second ledger.** `warehouse_stock.qty` stays the single
   authoritative quantity (ADR 0007). An accepted receipt line also opens a `stock_batches` row with its
   expiry; `expiring_batches()` and the pick screen read these, and `write_off_expired()` posts a normal
   `wastage` movement (which reduces `warehouse_stock`) and zeroes the batch, so the two stay in step on the
   path that matters. Orders do **not** consume specific batches — per-order batch tracking is Phase 2. This
   keeps the 205 existing stock invariants intact while giving the team FEFO visibility and an expiry write-off.
2. **A trip is how orders go out for delivery.** `dispatch_trip()` takes a draft trip (a driver, a vehicle and
   a set of **packed** orders) and, in one transaction, assigns the driver and moves each order to
   `out_for_delivery` with a 4-digit POD OTP. The older per-order `set_order_status(…, 'out_for_delivery')`
   still works for a driver without a trip; trips are the bulk, auditable path.
3. **Proof of delivery closes the order.** `complete_delivery()` — run by the assigned driver or by
   fulfilment:edit staff — checks the OTP (when the trip set one), records a photo and note, processes
   doorstep returns (reduce the billed line, restock, re-total), marks the order delivered, and for a COD order
   records the collected cash against the driver and marks it paid. A doorstep return must be **less** than the
   whole line; refusing a whole order is a cancellation.
4. **Driver cash is tracked, then settled.** Each COD delivery writes one `driver_cash` row; `settle_driver_cash()`
   (fulfilment:approve or payments:edit) records cash handed back; `driver_cash_summary()` shows collected vs
   in hand. Online-payment reconciliation is batch 7.
5. **Receiving stays inventory; planning and settlement are a new `fulfilment` module**, with a
   `logistics_partner` role scoped to one city. Delivery-charge rules live here but take effect through
   `place_order` in batch 6 (shipped alongside).

**Consequences.**
+ No change to the stock ledger's guarantees; expiry and FEFO are additive.
+ Trips give dispatch an auditable, bulk operation and a natural home for the POD OTP and the driver's run.
+ Cash is auditable end to end: collected on delivery, settled by finance.
− Batches can drift from `warehouse_stock` between a sale and the next write-off (a sold-but-not-yet-expired
  unit); the write-off caps the wastage at the live quantity so it never drives stock negative, and the ADR
  records that batches are advisory for everything except the expiry write-off.
− An order can sit on at most one trip (`trip_orders` is unique on the order); re-planning means removing it
  from the draft first.
