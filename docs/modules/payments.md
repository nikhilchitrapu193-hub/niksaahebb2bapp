# Module: Payments & credit

Build list section 8, Phase 1, batch 8 in `docs/build-roadmap.md`. Shipped as migration 015
(`supabase/migrations/20261020000002_payments_credit.sql`).

## What it does, in one paragraph
**Open-item receivables.** A delivered order is the invoice; a debit note is an extra charge. Money against them comes
from **receipts** (cash, UPI, bank transfer, cheque, online, other) and **credit notes** (migration 013), linked by
**allocations**. Balances are always computed from those rows, never stored, so they cannot drift. Receipts and credit
notes apply themselves **oldest-due-first** to pay-later invoices; finance can also apply by hand (that is how an advance is
applied to a cash-on-delivery invoice). **Every paid order has a receipt**: when the driver collects COD cash
(`complete_delivery`, migration 012) a trigger writes the receipt. Each sector and each customer can carry a **credit
limit** (NULL = no limit); an order gets a **due date** at delivery (delivered date + credit days for pay-later, the
delivered date for COD); a pay-later order is refused while an invoice is **overdue** (if the sector blocks it) or when it
would exceed the limit. Reports: the **ageing** table (current / 1–30 / 31–60 / 61–90 / 90+), one customer's **account**,
and a dated **statement** with running balance, printable. Online payments through **Razorpay** are wired end to end
(Edge Functions + webhook) and switch on when the keys are set.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261020000002_payments_credit.sql` |
| Security test | `supabase/tests/security_test.sql` T58–T60 (and T12l / T25b, rewritten) |
| Core JS | `web/js/core/receivables.js` (`fifoAllocate`, `agingTotals`, `daysOverdue`, `agingBucket`), `config.js` (`RECEIPT_METHODS`, `razorpayKeyId`, `MODULES.payments.nav`), `api.js` "Payments & credit" |
| Admin screens | `web/js/pages/admin/payments.js` (Receivables, Receipts, customer account, receipt / apply / debit-note / void dialogs); `orders.js` ("Record payment" on a delivered order); `customers.js` (credit limit override, Outstanding → Payments); `sectors.js` (credit limit, block on overdue); `dashboard.js` (receivables tiles) |
| Customer app | `web/js/pages/restaurant/payments.js` (owed, overdue, limit, open invoices, receipts, credit notes, statement, Pay online); `main.js` (pay-later disabled with the reason; overdue banner); `orders.js` (due date) |
| Printable | `web/statement.html` + `web/js/pages/statement.js`; `invoice.js` shows the due date |
| Edge Functions | `supabase/functions/razorpay-order/index.ts`, `supabase/functions/razorpay-webhook/index.ts` |
| Tests | `tests/unit.test.js` (allocation preview, ageing), `tests/pages.test.js` (receivables, receipts, record payment from an order, customer page, statement, no-access) |
| Docs | this file, `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, `docs/deployment.md`, ADR 0019 |

## Tables
| Table | Holds |
|---|---|
| `payments` | a receipt: `RCT-1000…`, customer, city (scope), amount, method, reference (UTR / cheque no.), received_on, note, gateway + gateway_ref (online; unique), received_by, voided_at / void_reason / voided_by |
| `debit_notes` | an extra charge: `DN-1000…`, customer, optional order, amount, reason, due_date |
| `payment_allocations` | one source (receipt **or** credit note) applied to one item (delivered order **or** debit note), amount |
| `sectors.credit_limit`, `sectors.block_credit_when_overdue`, `restaurants.credit_limit`, `orders.due_date` | the credit terms and the due date (columns added) |

## Functions
| Function | Who | Does |
|---|---|---|
| `record_payment(customer, amount, method, reference, received_on, note, allocations)` | payments:edit, in scope | writes the receipt; applies by hand or oldest-due-first; UPI / bank / cheque need a reference |
| `allocate_payment(payment, allocations)` | payments:edit | applies an unapplied receipt to chosen items (≤ each balance, ≤ what is left) |
| `void_payment(payment, reason)` | payments:approve | marks the receipt void; its invoices reopen; nothing is deleted |
| `raise_debit_note(customer, amount, reason, order, due)` | payments:edit | an open item; credit on account applies to it |
| `record_online_payment(customer, amount, gateway, ref, …)` | **service_role** (webhook) | a receipt of method `online`; a repeated `gateway_ref` returns `duplicate: true` |
| `customer_receivables(customer)` | the customer, or payments / customers:view in scope | position, limit, available, open items with days overdue, unapplied receipts / credit notes |
| `receivables_summary()` | payments:view | every customer in scope with a position: ageing buckets, overdue, oldest due, on account, limit |
| `customer_statement(customer, from, to)` | the customer, or payments:view in scope | opening balance, dated lines with running balance, closing balance |
| `admin_outstanding_balances()` (replaced) | customers:view or payments:view | same shape as before, now the open-item position |
| `my_order_terms()` (v3) | customer | adds `credit_limit`, `credit_available`, `outstanding`, `overdue`, `credit_blocked_reason` |
| `place_order_core()` (v8) | internal | the two credit rules |
| `admin_dashboard_stats()` (replaced) | dashboard:view | adds `receivables_open`, `receivables_overdue` |
| internal | – | `customer_balance`, `customer_credit_limit`, `allocated_to_order`, `allocated_to_debit_note`, `payment_unallocated`, `credit_note_unallocated`, `sync_order_payment_status`, `allocate_customer_credits`, `statement_events` |

Triggers: `orders_before_delivered` (stamps `delivered_at` and `due_date`), `orders_after_delivered` (a COD order becomes
driver cash + paid; then credit on account is applied), `orders_paid_receipt` (a receipt for any order that becomes paid without one — the COD path),
`credit_notes_apply` (a new credit note applies itself).

## Business rules
| Rule | Where |
|---|---|
| an invoice is a delivered order; nothing is owed before delivery | `customer_balance`, the triggers |
| due date = delivered date + credit days (customer override, else sector) for pay-later; the delivered date for COD | `orders_before_delivered` |
| credits apply oldest-due-first; a credit note goes to its own order first | `allocate_customer_credits` |
| a delivered COD order is cash in the driver's hand: driver cash + receipt at delivery, whichever screen delivered it; if no cash was collected, void the receipt and apply credit by hand | `orders_after_delivered`, `void_payment`, `allocate_payment` |
| the allocator never touches COD invoices (they are settled at the door) | `allocate_customer_credits` |
| two receipts for one customer cannot cover the same invoice twice (the customer row is locked per allocation run) | `allocate_customer_credits`, `allocate_payment`, `record_payment` |
| every paid order has a receipt | `orders_paid_receipt` |
| a receipt is voided, never deleted | `void_payment` |
| pay-later refused while overdue (sector `block_credit_when_overdue`) | `place_order_core`, mirrored in the cart by `my_order_terms.credit_blocked_reason` |
| pay-later refused when exposure (open invoices − credit on account + pay-later orders on the way) + this order > limit | `place_order_core` |
| credit on account counts towards what is available | `customer_balance.exposure` |
| outstanding may be negative (the customer is in credit) | `customer_balance` |

`payments.received_by` for a COD receipt is the driver; the cash itself is tracked separately in `driver_cash` /
`cash_settlements` (migration 012) — one is the customer's receivable, the other is cash custody.

## Online payments (Razorpay)
1. Razorpay dashboard: create API keys and a webhook (`<project>/functions/v1/razorpay-webhook`, event `payment.captured`, a secret).
2. Supabase → Edge Functions → Secrets: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
3. `supabase functions deploy razorpay-order` and `supabase functions deploy razorpay-webhook --no-verify-jwt`.
4. Put the key id into `web/js/core/config.js` → `razorpayKeyId`. The customer's Payments page now shows **Pay online**.
Until step 4 the button does not show and nothing else changes. The browser never marks anything paid: only the signed
webhook does, through `record_online_payment()`.

## Not in this batch
Interest on overdue dues (Phase 3), GST / Tally exports and profit per order (Phase 2 reports), customer-side users with an
approver role (Phase 2), automatic reminders (batch 9, notifications).
