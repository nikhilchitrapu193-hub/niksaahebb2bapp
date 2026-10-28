# Patch guide — Phase 1, Batches 7 & 8: Launch control ("lite mode") and Payments & credit (20 Oct 2026)

Two batches, shipped together. **Batch 7 — Launch control** (migration 014): Settings → Launch with three
switches — *live sectors* (start with army cantonments only; switch restaurants / caterers on later with one tick),
*pricing mode* (simple: type a price on the product form, pricing engine hidden) and *stock mode* (simple: in stock /
out of stock only, no quantities, Inventory + Procurement hidden). A sector that is off cannot sign up or order. The
order → pack → deliver → track flow is unchanged in every mode. **Batch 8 — Payments & credit** (migration 015):
receipts (cash / UPI / bank / cheque / online / other) applied oldest-due-first or by hand · void (never delete) · debit
notes · credit notes apply themselves · a receipt for every paid order (COD cash) · credit limit per sector / customer ·
due dates · overdue block · ageing report · customer account + printable statement · customer Payments page · Razorpay
online payments (two Edge Functions + webhook, dormant until keys are set). Full description:
`docs/modules/launch-control.md`, `docs/modules/payments.md`; ADRs 0018 and 0019.

Tested: `npm test` 115/115 · `security_test.sql` 239/239 PASS on a local Postgres 16 built from all 15 migrations · an
independent review pass over both migrations (money arithmetic, trigger chain, RLS, concurrency) with its findings fixed ·
every new screen (Launch, lite dashboard, simple product form, "switched off" page, Receivables, customer account,
receipt dialog, Receipts tab, record payment from an order, sectors / customer credit limit, the customer's Payments page,
the cart with credit blocked, the statement page) rendered in headless Chromium without errors.

**Status on the live project (bzxygscjhvcwahwqgqin): migrations 014 and 015 are NOT applied yet — you apply them, in
order (step 4).** The Supabase MCP tool refused 014 the same way it refused 011–013 (its replacement of
`rebuild_order_lines` clears an order's lines with a `DELETE` inside the function) and I won't disguise it; 015 has no
such statement but **must run after 014** (015 replaces `place_order_core` with a version that includes 014's sector
check *and* the credit rules — the other order would lose the credit rules), so both go through the SQL editor together.
Until they are applied the app keeps working as before; the Launch tab and Payments menu show but report missing
functions.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)

1. Unzip `fresh-supply-launch-payments-batch.zip` into `C:\Projects\fresh-supply\` — 46 files (16 new, 30 modified), in
   their folders. Say **yes** to replacing. (Unzip into the repo root only — if Windows offers a
   `…\fresh-supply-launch-payments-batch\` subfolder, delete that suffix so paths land at the root.)
2. `npm test` → `# pass 115`.
3. `git add -A` → `git commit -m "Phase 1 batches 7 & 8: launch control + payments & credit"` → `git push origin main`.
4. **Database, in this order, from the Supabase SQL editor** (confirm the "without WHERE" warning on 014 — the
   statements are inside functions and roll into the transaction):
   - paste `supabase/migrations/20261020000001_launch_control.sql` → *Run*
   - paste `supabase/migrations/20261020000002_payments_credit.sql` → *Run*
   - paste `supabase/tests/security_test.sql` → *Run* → every line `PASS`, 239 of them (it rolls back).
5. `npm start`, sign in as admin:
   - **Settings → Launch**: switch every sector except **Army cantonments & unit messes** off; Pricing → **Simple**;
     Stock → **Simple**; **Save modes** (the page reloads: Pricing, Inventory and Procurement leave the menu).
   - **Products → Add product**: name, SKU, category, price, unit, GST, minimum, photo, In stock. "More details" holds
     the rest.
   - Place a test order as a customer, confirm → pack → trip → deliver as before. Then **Payments**: the receivable
     appears when the order is delivered; **Record receipt** (or **Record payment** on the order) settles it; open the
     customer → **Statement**.
   - **Settings → Sectors & terms**: set a **Credit limit** and **Block credit when overdue** per sector;
     **Customers → Terms** overrides the limit per customer.
   - When restaurants are ready: **Settings → Launch** → switch Restaurants on. Nothing else changes.

## Files — NEW (16)

| Path | What it is |
|---|---|
| `supabase/migrations/20261020000001_launch_control.sql` | migration 014 (apply from the SQL editor) |
| `supabase/migrations/20261020000002_payments_credit.sql` | migration 015 (apply from the SQL editor, after 014) |
| `supabase/functions/razorpay-order/index.ts` | Edge Function: creates a Razorpay order for the signed-in customer (holds the secret) |
| `supabase/functions/razorpay-webhook/index.ts` | Edge Function: verifies Razorpay's signature and records the receipt (`record_online_payment`) |
| `web/js/core/launch.js` | pure rules: which modules the launch modes hide, dashboard summary |
| `web/js/core/receivables.js` | pure helpers: oldest-due-first allocation preview, ageing totals / buckets |
| `web/js/pages/admin/launch.js` | Settings → Launch |
| `web/js/pages/admin/payments.js` | Payments: Receivables, Receipts, customer account, receipt / apply / debit-note / void dialogs |
| `web/js/pages/restaurant/payments.js` | the customer's Payments page (owed, overdue, limit, invoices, receipts, credit notes, statement, Pay online) |
| `web/js/pages/statement.js`, `web/statement.html` | printable account statement (customer or finance) |
| `docs/modules/launch-control.md`, `docs/modules/payments.md` | module READMEs |
| `docs/adr/0018-launch-control-lite-mode.md`, `docs/adr/0019-open-item-receivables.md` | decision records |
| `docs/patches/2026-10-20-launch-payments-batch.md` | this guide |

## Files — MODIFIED (30, the highlights)

| Path | What changed |
|---|---|
| `web/js/core/config.js` | `razorpayKeyId` (empty = no Pay online button), `RECEIPT_METHODS`, `LAUNCH_PRICING_MODES`, `STOCK_MODES`, `MODULES.payments.nav` |
| `web/js/core/api.js` | "Launch control" and "Payments & credit" sections; `setOrderPayment` removed (the function is retired); credit limit on sector / customer terms |
| `web/js/core/permissions.js` | `visibleNav(me, hidden)` |
| `web/js/pages/admin/main.js` | reads the launch modes once, hides modules, "Switched off" guard; routes `#launch`, `#payments`, `#payments-receipts` |
| `web/js/pages/admin/products.js` | simple pricing: essentials + "More details" fold, price always typed (saved as a hand price); simple stock: no On hand column |
| `web/js/pages/admin/orders.js` | "Record payment" on a delivered order (receipt dialog, pre-ticked); due date; CSV due date |
| `web/js/pages/admin/dashboard.js` | launch-mode banner, Out of stock tile in simple stock, Receivables tile |
| `web/js/pages/admin/sectors.js`, `customers.js`, `settings.js` | credit limit + overdue block per sector, credit limit per customer, "sector off" badge, Launch tab |
| `web/js/pages/restaurant/main.js`, `orders.js` | Payments route; sector-off banner (ordering closed); pay later disabled with the reason; overdue banner; due date |
| `web/js/pages/login.js` | only live sectors on the sign-up form |
| `web/js/pages/invoice.js` | due date on unpaid invoices |
| `web/css/components.css` | the switch, the details fold, ageing table |
| `supabase/tests/security_test.sql` | T57 (launch), T58–T60 (payments); T12l / T25b rewritten for receipts — 239 checks |
| `supabase/tests/local_postgres_stub.sql` | `service_role` for the webhook grant (local runs only) |
| `tests/unit.test.js`, `tests/pages.test.js` | launch rules, allocation preview, ageing; 10 new screen tests; nav count 12 |
| `docs/*`, `README.md`, `AGENTS.md`, `CLAUDE.md` | api / roles / runbook / testing / deployment / roadmap / feature map / ADR index / rules 18–19 |

## Notes for the owner

* **Lite is a configuration, not a second app.** Everything you switch off stays in the database; switching it on
  later shows it as it was. Products added in simple mode are ordinary hand-priced products.
* **Simple stock means the in-stock toggle is the control.** Orders do not check or reserve quantities. If you later go
  *Counted*, receive stock first (Inventory) or orders will fail with "Only 0 available". The ledger stays honest across
  the switch: each order remembers whether it reserved stock, so it only ever returns what it took.
* **"Mark paid" is gone; receipts replace it.** Every rupee has a receipt number now, including the driver's COD cash
  (written automatically at delivery — whether the driver's app or the Orders screen marks it delivered; if no cash was
  in fact collected, void that receipt and the invoice reopens). Mistakes are voided with a reason, never deleted.
* **Nothing is owed before delivery.** The receivable appears when the order is delivered, due after the customer's
  credit days (cash on delivery: that day). A receipt recorded earlier sits on account and applies itself to the next
  pay-later invoice; apply it to a COD invoice by hand from the customer's account.
* **Credit rules bite only on pay-later orders.** An overdue invoice (if the sector blocks it) or a full credit limit
  refuses pay later and the cart says why; cash on delivery stays open.
* **Razorpay is dormant until keys are set** — steps in `docs/modules/payments.md`. The browser can never mark a payment
  as received; only the signed webhook can.
