# Module: Procurement (rate cards, buying list, purchase orders, goods receipts)

Build list section 5, Phase 1 (batch 4 in `docs/build-roadmap.md`). Shipped as migration 011
(`supabase/migrations/20261015000006_procurement.sql`).

## What it does, in one paragraph
Each supplier has a **rate card**: what they charge per product, the minimum order quantity, lead days and
validity, with one supplier ticked as *preferred* per product. The **buying list** looks at one warehouse and
one delivery day and, per product, shows the demand on open orders, free stock, what is already on order and
a suggested quantity (demand × days of cover + alert level − free stock − on order, rounded up to the MOQ)
priced at the preferred supplier's rate. Ticked rows become one draft **purchase order** per supplier; a
draft is edited, then *approved & sent* (printable PO page, WhatsApp share). When goods arrive the team
**receives** against the PO line by line — accepted, rejected with a reason, grade, actual unit cost — and a
**goods receipt (GRN)** is written; accepted quantity goes into stock through the ledger with the cost and
the GRN number on the movement, and the PO moves to part-received or closed by itself. Mandi cash purchases
and direct deliveries use the same receipt form (bill amount, paid in cash, photo of the bill), so *every*
receipt in the system is a GRN.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261015000006_procurement.sql` |
| Security test | `supabase/tests/security_test.sql` T44–T48 |
| Core JS | `web/js/core/procurement.js` (buying arithmetic, PO totals, outstanding lines, PO message — pure), `api.js` section "Procurement", `config.js` (`MODULES.procurement`, `PO_STATUSES`, `GRN_SOURCES`, `billBucket`) |
| Admin screens | `web/js/pages/admin/buying-list.js` (Procurement home + shared tab strip), `purchase-orders.js`, `grn.js` (receipts list + the one receive form), `rate-cards.js`; `inventory.js` now opens the shared receive form; `main.js` routes |
| Printable | `web/po.html` + `web/js/pages/po.js` |
| Tests | `tests/unit.test.js` (procurement helpers), `tests/pages.test.js` (buying list → POs, approve, receive against PO, mandi, rate cards, inventory receive, picker refused) |
| Docs | this file, `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, ADR 0015 |

## Tables
| Table | Holds |
|---|---|
| `supplier_products` | the rate card: `supplier_id`, `product_id`, `price`, `moq`, `lead_days`, `valid_from` / `valid_to`, `is_preferred` (one preferred per product, enforced by a partial unique index) |
| `purchase_orders` | `po_number` (PO-1000…), supplier, warehouse, city, status `draft → sent → part_received → closed` (or `cancelled`), expected date, notes, who created / approved / closed and when |
| `purchase_order_items` | per line `qty_ordered`, `unit_cost` (typed or taken from the rate card), `qty_received`, `qty_rejected` (kept up to date by receipts) |
| `goods_receipts` | `grn_number` (GRN-1000…), optional PO and supplier, warehouse, city, `source` (po / mandi / direct), `bill_photo_path`, `bill_amount`, `paid_cash`, note, who received |
| `goods_receipt_items` | per line `qty_accepted`, `qty_rejected`, `unit_cost`, `grade`, `reject_reason`, optional photo |
| Storage | private bucket `purchase-bills` (JPEG / PNG / WebP, 8 MB): read with inventory:view, upload with inventory:edit; the app shows signed links |

Audit: `supplier_products`, `purchase_orders`, `purchase_order_items`, `goods_receipts` and (from now on)
`suppliers` are audited by the generic `write_audit_log()` trigger. Stock stays in `stock_movements`
(reason `received`, `reference` = the GRN number, `supplier_id`, `unit_cost`).

## Functions
| Function | Who | Does |
|---|---|---|
| `preferred_rate(product)` | internal | the preferred supplier's valid rate card row for a product |
| `buying_list(warehouse, delivery_date, cover_days)` | procurement:view, warehouse in scope | one row per active product: demand on open orders for that day and warehouse, free stock, alert level, open PO quantity, suggested quantity, preferred supplier + rate + MOQ + lead days, latest and 30-day average cost |
| `create_purchase_order(supplier, warehouse, expected_date, notes, items)` | procurement:edit, in scope | a draft PO; a line without a cost takes the rate card |
| `update_purchase_order(po, expected_date, notes, items)` | procurement:edit | replaces a **draft's** lines and details |
| `set_purchase_order_status(po, status)` | `sent` needs procurement:approve; `closed` / `cancelled` need procurement:edit | approve & send; close short; cancel (only while nothing has been received) |
| `receive_goods(warehouse, supplier, po, source, items, note, bill_photo_path, bill_amount, paid_cash)` | inventory:edit, warehouse in scope | writes the GRN, moves accepted stock through `apply_stock_movement`, updates the PO lines and status; returns `{id, grn_number, po_status}` |

The older `receive_stock()` (migration 006) still exists for compatibility but the app no longer calls it.

## Business rules (each is one named function or constraint)
| Rule | Where |
|---|---|
| One preferred supplier per product | `supplier_products_preferred_idx` (partial unique index) |
| Suggested quantity = max(0, demand × days of cover + alert level − free stock − on order) | `buying_list()`; `suggestedBuy()` mirrors it in the browser so "days of cover" recalculates without a round trip |
| PO line cost defaults to the preferred / chosen supplier's rate | `create_purchase_order()` |
| Only a draft can be edited; only a PO with nothing received can be cancelled | `update_purchase_order()`, `set_purchase_order_status()` |
| Rejected quantity needs a reason; a mandi receipt needs a bill amount; a PO receipt may only contain the PO's products | `receive_goods()` |
| A receipt moves the PO to part-received, or closed once every line is fully received or rejected | `receive_goods()` |
| Every receipt is a GRN; stock only changes through the ledger | `receive_goods()` → `apply_stock_movement()`; rule 17 in `AGENTS.md` |

## Why "days of cover" (and an open question)
Orders reserve stock when they are placed (`place_order` refuses an order the warehouse cannot cover, ADR 0007).
So on the morning of the delivery day the plain "orders − stock" shortfall is never positive: the stock was
there when the order went in. The buying list therefore plans *forward*: the day's demand, repeated for the
number of days of cover, plus the low-stock alert level, minus what is free and already on order. One day of
cover with alert levels set is "buy enough to serve tomorrow again". If the business decides to accept orders
beyond stock (buy-to-order), `place_order`'s availability check becomes a setting and the buying list's
demand column already shows what to buy — no change to this module.

## Not in this batch
Supplier portal and three-way match (Phase 2), supplier payments and ageing (batch 7), batches / expiry on
receipt (batch 5 adds `batch_no` / `expiry_date` to receipt lines), returns to supplier as a separate
document (today the rejected quantity and reason on the receipt line is the record).
