# Module: Fulfilment & delivery (batches, pick lists, trips, POD, driver cash)

Build list section 6, Phase 1 (batch 5 in `docs/build-roadmap.md`). Shipped as migration 012
(`supabase/migrations/20261015000007_fulfilment.sql`).

## What it does, in one paragraph
Goods received with an expiry date become **stock batches**; the pick list and the **near-expiry**
panel read them, and `write_off_expired()` posts wastage for anything past its date. For a delivery day the
**pick list** aggregates what to pick across confirmed orders. The team builds a **trip sheet** — a driver,
a vehicle and a set of confirmed/packed orders — and **dispatches** it: every packed order goes out for
delivery under that driver with a 4-digit **POD OTP**. At the door the driver **completes** the delivery with
a photo and the code; items refused at the door are **doorstep returns** that reduce the billed lines and go
back to stock, and a COD order's cash is recorded against the driver. Finance **settles** that cash.
**Delivery-charge rules** (per city / slot, with a free-above threshold) feed the order's delivery fee
(used by `place_order`, migration 013). A `logistics_partner` team role can see fulfilment for its city only.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261015000007_fulfilment.sql` |
| Security test | `supabase/tests/security_test.sql` T49–T52 |
| Core JS | `web/js/core/fulfilment.js` (trip stops, COD-to-collect, expiry tone, pick totals, doorstep-return builder — pure), `api.js` "Fulfilment & delivery", `config.js` (`TRIP_STATUSES`, `podBucket`) |
| Admin screens | `web/js/pages/admin/fulfilment.js` (pick list + expiry + the shared tab strip), `trips.js`, `driver-cash.js`, `delivery-charges.js`; `main.js` routes |
| Delivery app | `web/js/pages/delivery/main.js` — the driver completes a delivery (photo + OTP + doorstep returns) |
| Tests | `tests/unit.test.js` (fulfilment helpers), `tests/pages.test.js` (pick list, trip build + dispatch, driver cash, delivery charges, delivery completion, picker refused) |
| Docs | this file, `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, ADR 0016 |

## Tables
| Table | Holds |
|---|---|
| `stock_batches` | a receipt with its expiry: warehouse, product, GRN, batch no, received / remaining qty, unit cost, expiry date |
| `vehicles` | the delivery fleet per city (registration, label, capacity note, active) |
| `trips` | a trip sheet: `trip_number` (TRIP-1000…), driver, vehicle, date, slot, status `draft → dispatched → closed` (or `cancelled`) |
| `trip_orders` | the orders on a trip (one trip per order), with a stop sequence |
| `delivery_returns` | what came back at the door, per order line (qty, reason) |
| `driver_cash` | COD cash a driver collected, one row per order |
| `cash_settlements` | cash handed back / banked, by driver |
| `delivery_charge_rules` | per city + slot: a fee and a free-above threshold; most specific active rule wins |
| orders (new columns) | `delivered_at`, `pod_photo_path`, `pod_otp`, `pod_note`, `return_total` |
| Storage | private bucket `delivery-pod` (JPEG/PNG/WebP, 8 MB): staff with fulfilment:view read via signed links; the driver app uploads |

## Functions
| Function | Who | Does |
|---|---|---|
| `pick_list(warehouse, date, slot?)` | fulfilment:view, in scope | per product, what to pick across that day's confirmed orders, the order count, free stock and shortfall |
| `expiring_batches(warehouse, within_days)` | fulfilment:view or inventory:view, in scope | batches at or within N days of expiry (0 = expired), with days-left and an expired flag |
| `write_off_expired(warehouse)` | inventory:edit, in scope | posts wastage for every expired batch and zeroes it; returns `{batches, qty}` |
| `create_trip` / `update_trip` | fulfilment:edit, in scope | build / change a draft trip from confirmed or packed orders of one warehouse |
| `dispatch_trip(trip)` | fulfilment:edit, in scope | every **packed** order goes out for delivery under the driver, each with a POD OTP |
| `set_trip_status(trip, 'closed'/'cancelled')` | fulfilment:edit | close a dispatched trip, or cancel a draft |
| `complete_delivery(order, otp?, photo?, note?, returns)` | the assigned driver, or fulfilment:edit in scope | marks delivered with POD; doorstep returns reduce the billed lines and restock; a COD order's cash is recorded and the order marked paid |
| `settle_driver_cash(driver, amount, note)` | fulfilment:approve or payments:edit | records cash handed back |
| `driver_cash_summary()` | fulfilment:view or payments:view | per driver: collected, settled, in hand |
| `delivery_fee_for(city, slot, subtotal, sector_mov, sector_fee)` | internal | the delivery fee for an order (rule, else the sector fee) — called by `place_order` (013) |

`receive_goods()` (migration 011) is re-emitted so an accepted line also opens a `stock_batches` row with the
batch number and expiry the receiver typed; `goods_receipt_items` gains `batch_no` and `expiry_date`.

## Business rules
| Rule | Where |
|---|---|
| warehouse_stock is the authoritative total; batches are the expiry overlay reconciled by the write-off | ADR 0016; `write_off_expired()` posts the wastage movement |
| a trip only dispatches **packed** orders; confirmed-but-unpacked are refused | `dispatch_trip()` |
| the POD OTP must match at the door (when the trip set one) | `complete_delivery()` |
| a doorstep return must be less than the whole line (a full refusal is a cancellation) | `complete_delivery()`, `buildReturns()` |
| receiving stays an **inventory** permission; planning, trips and settlement are **fulfilment** | the permission seeds |

## Not in this batch
Batch-level consumption on every order (Phase 2 — batches are the expiry overlay here, not a per-order ledger),
route optimisation and live driver tracking, a full logistics-partner portal (the role exists; a separate
self-service app is Phase 2), and online-payment settlement of COD (batch 7, Payments & credit).
