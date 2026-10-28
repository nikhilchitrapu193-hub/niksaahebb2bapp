# 0019 — Receivables are open items computed from receipts and allocations; every paid order has a receipt
**Status:** Accepted

**Context.** Batch 8 brings credit limits, ageing, statements, receipts and online payments. Until now "paid" was a flag
on the order (`set_order_payment`) with no record of how or when the money came; credit notes (ADR 0017) were recorded but
not applied; COD cash was tracked for the driver but not against the customer.

**Decision.**
1. **Open items, no ledger table.** A delivered order is the invoice; a debit note is an extra charge. Receipts
   (`payments`) and credit notes are applied to them through `payment_allocations`. Balances (`customer_balance`,
   `receivables_summary`, `customer_statement`) are computed from those rows every time, so there is no second total to
   keep in step. The cost is a few sub-queries per customer, cheap at this scale.
2. **Oldest due first, by the database.** `allocate_customer_credits()` applies unapplied receipts and credit notes to
   pay-later invoices oldest-due-first (a credit note to its own order first). It runs when a receipt is recorded, a
   credit note is raised, a debit note is raised, and an order is delivered — so an advance is used the moment there is an
   invoice. Cash-on-delivery invoices are settled at the door and are never auto-applied; finance applies by hand
   (`allocate_payment`) when a prepaid customer's COD order needs it. The browser shows the same rule as a preview
   (`fifoAllocate`), it never decides.
3. **Every paid order has a receipt.** Any path that marks an order paid without a covering allocation — today the
   driver's COD cash in `complete_delivery` — gets a receipt written by the `orders_paid_receipt` trigger. The flag
   `payment_status` stays (every screen reads it) but is now derived: `sync_order_payment_status()` sets it from the
   balance. `set_order_payment` is retired (renamed `_legacy`, no grant).
4. **Void, never delete.** A wrong or bounced receipt is marked void (`voided_at`, reason, by whom) and stops counting;
   its invoices reopen. Nothing is deleted, the audit trail stays whole, and the migration contains no row-removal
   statement.
5. **Credit rules at order time, mirrored in the cart.** `place_order_core` refuses a pay-later order while an invoice is
   overdue (sector switch `block_credit_when_overdue`) or when exposure (open invoices − credit on account + pay-later
   orders not yet delivered) plus this order would exceed the credit limit (customer override, else sector, NULL = none).
   `my_order_terms` returns the same verdict (`credit_blocked_reason`) so the cart disables the option with the reason
   instead of failing at submit.
6. **Online payments only through the webhook.** `razorpay-order` (customer JWT, holds the secret) creates the gateway
   order with the customer id in server-set notes; `razorpay-webhook` verifies the HMAC and calls
   `record_online_payment()`, which is granted to the service role alone and is idempotent on the gateway payment id.
   The browser cannot mark anything paid.

**Consequences.**
+ Statements, ageing and the dashboard agree because they read the same rows; a void or a credit note shows everywhere at once.
+ Finance has one place for money (Payments) and the customer sees exactly the same numbers.
− Allocation tables are more rows than a paid flag; `receivables_summary` scans all delivered orders (fine for Phase 1;
  index on `orders(restaurant_id, due_date)` added for when it is not).
− COD receipts carry the driver as `received_by` while the cash itself lives in `driver_cash`: two records of one note,
  on purpose (receivable vs custody).
