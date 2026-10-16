# Patch guide — Phase 1, Batches 5 & 6: Fulfilment and Orders + (16 Oct 2026)

Two batches, shipped together. **Batch 5 — Fulfilment & delivery** (migration 012): stock batches with expiry +
near-expiry write-off · pick list per warehouse/day/slot · vehicles · trip sheets (build → dispatch with a POD
OTP → close) · proof of delivery (photo + code) · doorstep returns to stock · driver COD cash collection +
settlement · delivery-charge rules · a `logistics_partner` role. **Batch 6 — Orders +** (migration 013): slot
cut-offs & capacity · edit an order (customer before cut-off, staff before packing) · order on behalf of a
customer · cut-off-aware cancellation · report an issue → credit note.
Full description: `docs/modules/fulfilment.md`, `docs/modules/orders-plus.md`; ADRs 0016 and 0017.

Tested: `npm test` 101/101 · `security_test.sql` 205/205 PASS on a local Postgres 16 built from the migrations ·
every new screen (pick list, trips, driver cash, delivery charges, slots, issues, the driver's POD sheet, the
customer edit/cancel/issue, order-on-behalf) rendered in headless Chromium without errors.

**Status on the live project (bzxygscjhvcwahwqgqin): migrations 012 and 013 are NOT applied yet — you apply
them (step 4).** As with batch 4, the Supabase MCP tool I use refuses any migration whose text contains a
row-removal statement, even inside a function (012's `update_trip` and 013's `edit_order` rebuild rows with a
`DELETE`), and I won't disguise them to get past that guard. The SQL editor runs them fine. Until they are
applied, the Fulfilment menu and the new order actions show but report missing functions; everything else keeps
working.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)

1. Unzip `fresh-supply-fulfilment-orders-batch.zip` into `C:\Projects\fresh-supply\` — 34 files (13 new,
   21 modified), in their folders. Say **yes** to replacing. (Unzip into the repo root only — if Windows offers
   a `…\fresh-supply-fulfilment-orders-batch\` subfolder, delete that suffix so paths land at the root.)
2. `npm test` → `# pass 101`.
3. `git add -A` → `git commit -m "Phase 1 batches 5 & 6: fulfilment + orders"` → `git push origin main`.
4. **Database, in order, from the Supabase SQL editor** (confirm the "without WHERE" warning each time — the
   statements are inside functions and roll into the transaction):
   - paste `supabase/migrations/20261015000007_fulfilment.sql` → *Run*
   - paste `supabase/migrations/20261015000008_orders_plus.sql` → *Run*
   - paste `supabase/tests/security_test.sql` → *Run* → every line `PASS`, 205 of them (it rolls back).
   Optionally paste the two new blocks at the end of `supabase/seed.sql` (a sample vehicle, slot cut-offs and an
   express delivery fee) if you want the sample ops config on the live project.
5. `npm start`, sign in as admin:
   - **Fulfilment → Pick list**: choose tomorrow; **Write off expired** if the panel shows anything.
   - **Fulfilment → Trips → New trip**: pick confirmed/packed orders, a driver and vehicle → **Dispatch**.
   - Sign in to the **delivery** app as that driver → **Complete delivery** (photo, the 4-digit code, returns).
   - **Fulfilment → Driver cash**: settle the collected COD.
   - **Settings → Delivery slots**: set cut-offs / capacity. **Fulfilment → Delivery charges**: per-slot fees.
   - **Orders → New order for a customer**; open a placed order to **Edit**; **Orders → Issues & credits** to
     resolve a reported issue and raise a credit note.

## Files — NEW (13)

| Path | What it is |
|---|---|
| `supabase/migrations/20261015000007_fulfilment.sql` | migration 012 (apply from the SQL editor) |
| `supabase/migrations/20261015000008_orders_plus.sql` | migration 013 (apply from the SQL editor) |
| `web/js/core/fulfilment.js` | pure helpers: trip stops, COD-to-collect, expiry tone, pick totals, doorstep-return builder |
| `web/js/pages/admin/fulfilment.js` | Pick list + near-expiry + the fulfilment tab strip |
| `web/js/pages/admin/trips.js` | Trip sheets: build, dispatch, close |
| `web/js/pages/admin/driver-cash.js` | Driver cash collected vs settled; settle |
| `web/js/pages/admin/delivery-charges.js` | Per city/slot delivery fees |
| `web/js/pages/admin/slots.js` | Settings → Delivery slots (cut-offs + capacity) |
| `web/js/pages/admin/issues.js` | Orders → Issues & credits |
| `docs/modules/fulfilment.md`, `docs/modules/orders-plus.md` | module READMEs |
| `docs/adr/0016-fulfilment-batches-trips-pod.md`, `docs/adr/0017-order-edit-slots-credit-notes.md` | decision records |

## Files — MODIFIED (21, the highlights)

| Path | What changed |
|---|---|
| `web/js/core/api.js` | "Fulfilment & delivery" and "Orders +" sections (trips, pick list, POD, cash, charges, slots, edit, issues, credit notes) |
| `web/js/core/config.js` | `MODULES.fulfilment`, `TRIP_STATUSES`, `ISSUE_KINDS`, `ISSUE_STATUSES`, `podBucket` |
| `web/js/pages/admin/main.js` | routes `#fulfilment`, `#trips`, `#driver-cash`, `#delivery-charges`, `#slots`, `#issues` |
| `web/js/pages/admin/orders.js` | "New order for a customer" (order-on-behalf) and an Issues link |
| `web/js/pages/admin/settings.js` | Delivery-slots tab |
| `web/js/pages/delivery/main.js` | the driver completes a delivery (photo + OTP + doorstep returns) |
| `web/js/pages/restaurant/orders.js` | edit a placed order, cancel (cut-off aware), report an issue |
| `supabase/tests/security_test.sql` | T49–T56 (fulfilment + orders+); clears seeded slot/charge config so totals stay deterministic — 205 checks |
| `supabase/seed.sql` | sample vehicle, slot cut-offs, express delivery fee |
| `tests/unit.test.js`, `tests/pages.test.js` | fulfilment helpers + the new screens; nav count 11 |
| `docs/*`, `AGENTS.md`, `CLAUDE.md` | api / roles / runbook / testing / deployment / roadmap / feature-map / file maps |

## Notes for the owner

* **Expiry vs stock.** `warehouse_stock` stays the real quantity; batches are an expiry overlay. Receiving with
  an expiry date opens a batch; **Write off expired** posts the wastage and reconciles the two. Orders don't yet
  consume specific batches (that's Phase 2) — batches are for FEFO visibility and the write-off (ADR 0016).
* **Slots are dark by default.** No `slot_config` row = the slot is always open and uncapped, so ordering is
  unchanged until you set cut-offs under Settings → Delivery slots. Staff ordering on behalf bypass the cut-off.
* **Ordering beyond stock stays off** (the ADR 0007 question): an order still can't exceed free stock. Buy-to-order
  is a future setting; nothing here depends on flipping it.
* **Credit notes are recorded, not yet refunded.** `resolve_issue` raises a credit note (capped at the order
  total); applying it to the account balance is batch 7 (Payments & credit), which reads `credit_notes` and the
  COD cash from batch 5.
