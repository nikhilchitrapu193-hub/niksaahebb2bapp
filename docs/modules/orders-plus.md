# Module: Orders + (slots & cut-offs, edit, order-on-behalf, cancellation, issues → credit notes)

Build list section 7, Phase 1 (batch 6 in `docs/build-roadmap.md`). Shipped as migration 013
(`supabase/migrations/20261015000008_orders_plus.sql`).

## What it does, in one paragraph
Each slot can carry a **cut-off hour** and a per-day **capacity** (`slot_config`); `slot_open()` decides whether
a slot still takes an order for a delivery date. `place_order` is rebuilt (v6) around a shared core so the same
logic serves the customer's order, a staff **order on behalf of a customer** (`place_order_for`) and
**editing** an order (`edit_order`) — stock is returned and re-reserved and the order re-priced and re-totalled.
The delivery fee now comes from the **delivery-charge rules** (migration 012), falling back to the sector fee.
A customer can **edit** or **cancel** a placed order before its cut-off; staff can edit until it is packed and
cancel any order that is not delivered. A customer **reports an issue** on a delivered order; support
**resolves** it and may raise a **credit note** (applied to the account balance in batch 7).

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261015000008_orders_plus.sql` |
| Security test | `supabase/tests/security_test.sql` T53–T56 |
| Core JS | `api.js` "Orders +" (`placeOrderFor`, `editOrder`, `cancelOrder`, `slotOpen`, `reportIssue`, `resolveIssue`, `listOrderIssues`, `listCreditNotes`, `listSlotConfig`/`saveSlotConfig`), `config.js` (`ISSUE_KINDS`, `ISSUE_STATUSES`) |
| Admin screens | `web/js/pages/admin/issues.js` (issues queue + credit notes), `slots.js` (Settings → Delivery slots); `orders.js` gains "New order for a customer"; `settings.js` tab |
| Customer app | `web/js/pages/restaurant/orders.js` — edit a placed order, cancel, report an issue |
| Tests | `tests/pages.test.js` (customer edit, customer report issue, admin resolve + credit, order-on-behalf) |
| Docs | this file, `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, ADR 0017 |

## Tables
| Table | Holds |
|---|---|
| `slot_config` | per city + slot: cut-off hour (IST) and optional per-day capacity; most specific (city) wins, no row = always open |
| `order_issues` | a problem a customer reports: order, kind (quality / short / damaged / wrong_item / other), note, status `open → resolved`/`rejected`, resolution |
| `credit_notes` | a credit owed to a customer (`CN-1000…`) from a resolved issue; consumed by batch 7 |

## Functions
| Function | Who | Does |
|---|---|---|
| `slot_open(city, date, slot)` | any signed-in | `{open, reason}` — cut-off + capacity check |
| `place_order` (v6) | approved customer (self) | places their own order; obeys the cut-off / capacity |
| `place_order_for(restaurant, …)` | orders:edit, in scope | places an order for a customer; may place past the cut-off |
| `edit_order(order, items, …)` | the customer (placed, before cut-off) or orders:edit (placed / confirmed, before packing) | rebuilds the lines (stock returned and re-reserved), re-prices and re-totals |
| `cancel_order(order, reason)` | the customer (placed, before cut-off) or orders:edit (not delivered) | cancels and returns stock |
| `report_issue(order, kind, note)` | the order's customer, or orders:edit in scope | opens an issue |
| `resolve_issue(issue, resolution, credit_amount, reject)` | orders:edit, in scope | resolves (or declines); a credit amount > 0 raises a credit note (≤ the order total) |

`rebuild_order_lines()` and `place_order_core()` are the internal shared core (no direct grant); `place_order`
v5 is kept as `place_order_v5_legacy` (house rule: no DROP in migrations).

## Business rules
| Rule | Where |
|---|---|
| a slot with no config is always open and uncapped (ordering behaves as before until an admin sets cut-offs) | `slot_open()` |
| customers obey the cut-off / capacity; staff (`place_order_for`) may place late | `place_order_core(p_enforce_slot)` |
| an order can be edited until it is packed; a customer only while placed and within the sector's edit window (migration 017) — the slot cut-off remains a hard ceiling after | `edit_order()`, `cancel_order()` |
| a credit note cannot exceed the order total | `resolve_issue()` |
| editing returns the old reservations and makes new ones (two honest ledger rows) | `rebuild_order_lines()` |

## Not in this batch
The per-sector edit window is set on **Settings → Sectors & terms** (migration 017: `sectors.customer_edit_window_minutes`); the customer app reads it from `my_order_terms` and the database re-checks every call.

## Not in this batch
Substitutions when editing (Phase 2), standing / recurring orders (Phase 2), and applying a credit note to the
customer's balance or an invoice — that is batch 7 (Payments & credit), which reads `credit_notes`.
