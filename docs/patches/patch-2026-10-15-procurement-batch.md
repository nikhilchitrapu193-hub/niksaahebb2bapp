# Patch guide — Phase 1, Batch 4: Procurement (15 Oct 2026)

What this batch adds (build list section 5, Phase 1): supplier **rate cards** (price, MOQ, lead days, validity,
one preferred supplier per product) · the **buying list** per warehouse and delivery day (demand on open
orders, free stock, on order, alert level → suggested quantity, rounded to the MOQ; "days of cover") → one
draft **purchase order** per supplier · PO approve & send, printable PO page, WhatsApp share, edit draft, close
short, cancel · **receive against a PO** line by line (accepted / rejected with reason / grade / actual cost;
PO moves to part-received or closed by itself) · **mandi cash purchase** (bill amount, paid in cash, photo of
the bill) · a **Receipts** screen (every GRN with its quality check, CSV) · Inventory → *Receive stock* now
opens the same goods-receipt form, so every receipt in the system is a GRN.
Full description: `docs/modules/procurement.md`, decision record ADR 0015.

Tested: `npm test` 86/86 · `security_test.sql` 174/174 PASS on a local Postgres 16 built from the migrations
· the four procurement screens, the PO print page and the inventory receive form rendered in headless
Chromium without errors.

**Status on the live project (bzxygscjhvcwahwqgqin), 15 Oct 2026 22:10 IST: migration 011 is applied**
(the owner ran it from the SQL editor: the MCP tool refuses any migration whose text contains a row-removal
statement, even inside a function — `update_purchase_order()` replaces a draft's lines). The live database
now also carries the sample data from `seed.sql` that batches 2 and 3 had left out (sample quotes,
sub-categories, grades, loose-weight flags, the 25 kg rice bag), so it matches a fresh install and the
security test's counts. `security_test.sql` T36 no longer relies on the seed's paneer quote (it inserts its
own); run the updated file once (step 4) — expect 174 PASS.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)

1. Unzip `fresh-supply-procurement-batch.zip` into `C:\Projects\fresh-supply\` — 33 files (10 new,
   23 modified), in their folders. Say **yes** to replacing.
2. `npm test` → `# pass 86`.
3. `git add -A` → `git commit -m "Phase 1 batch 4: procurement - rate cards, buying list, purchase orders, GRN"` → `git push origin main`.
4. **Database:** migration 011 is already live (see above). Paste the updated `supabase/tests/security_test.sql`
   into the SQL editor → *Run* (confirm the "UPDATE without WHERE" warning: it is the test's own
   `company_settings` check, and the whole test rolls back) → every line `PASS`, 174 of them.
5. `npm start`, sign in as admin:
   - **Inventory → Suppliers**: make sure each supplier has a phone number (WhatsApp share uses it).
   - **Procurement → Rate cards**: pick a supplier, type price / MOQ / lead days per product, tick *Preferred*,
     *Save rates*.
   - **Procurement** (buying list): tomorrow's date; set *Days of cover*; tick rows → *Create purchase orders*.
   - **Purchase orders**: open the draft → *Approve & send* → *Print / PDF* or *Share on WhatsApp*.
   - When goods arrive: open the PO → *Receive goods*; or **Receipts → Mandi cash purchase**.
   - **Inventory → Receive stock** now opens the same form (direct receipt, no PO).
   - Settings → Roles: the new *procurement* column; the buyer role has view / edit / export, the city
     manager also *approve*.

## Files — NEW (10)

| Path | What it is |
|---|---|
| `supabase/migrations/20261015000006_procurement.sql` | **NEW** — migration 011 (apply from the SQL editor, step 4) |
| `web/js/core/procurement.js` | **NEW** — pure helpers: `suggestedBuy` (mirror of `buying_list()`), `roundToMoq`, `groupBySupplier`, `poTotals`, `outstandingLines`, `poMessage`, `whatsappLink` |
| `web/js/pages/admin/buying-list.js` | **NEW** — Procurement home: the buying list, the shared tab strip, create POs |
| `web/js/pages/admin/purchase-orders.js` | **NEW** — PO list, detail (print, WhatsApp, approve, receive, close, cancel), create / edit form |
| `web/js/pages/admin/grn.js` | **NEW** — Receipts list + detail, and the one `receiveForm` used by PO, Receipts, mandi and Inventory |
| `web/js/pages/admin/rate-cards.js` | **NEW** — Rate cards per supplier |
| `web/po.html` + `web/js/pages/po.js` | **NEW** — printable purchase order (`po.html?po=<id>`) |
| `docs/modules/procurement.md` | **NEW** — the module README |
| `docs/adr/0015-procurement-po-grn-buying-list.md` | **NEW** — decision record |
| `docs/patches/2026-10-15-procurement-batch.md` | **NEW** — this guide |

## Files — MODIFIED (23)

| Path | What changed |
|---|---|
| `supabase/tests/security_test.sql` | T44–T48 (permissions, rate cards and buying list, PO lifecycle, receiving against a PO, mandi purchase) — 174 checks |
| `web/js/core/api.js` | section "Procurement" (rate cards, buying list, POs, receipts, bill photo upload / signed link); the old `receiveStock` wrapper removed (the UI no longer calls `receive_stock`) |
| `web/js/core/config.js` | `MODULES.procurement`, `PO_STATUSES`, `GRN_SOURCES`, `billBucket` |
| `web/js/core/shell.js` | the active menu item scrolls into view (ten modules no longer fit on every laptop) |
| `web/css/components.css` | header: tighter nav padding, scrollable menu, "Admin" subtitle hidden under 1180 px |
| `web/js/pages/admin/main.js` | routes `#procurement`, `#purchase-orders`, `#receipts`, `#rate-cards` (guarded by `procurement`) |
| `web/js/pages/admin/inventory.js` | *Receive stock* opens the shared GRN form (`grn.js`); its own form removed |
| `tests/unit.test.js` | procurement helper tests (T45 numbers); nav count 10 |
| `tests/pages.test.js` | buying list → POs, PO approve + receive, mandi, rate cards, picker refused; inventory tests now expect `receive_goods` |
| `tests/helpers/fake-supabase.js` | `createSignedUrl` on the storage fake |
| `README.md` | file map, 174 checks, roadmap line |
| `AGENTS.md`, `CLAUDE.md` | rule 5 names `receive_goods`; **rule 17 — every receipt is a GRN**; file map |
| `docs/api.md` | the six functions, tables, direct writes, the Procurement section, audit list, `purchase-bills` bucket |
| `docs/roles.md` | `procurement` module and its permissions; buyer role description |
| `docs/runbook.md` | "Buying: rate cards, buying list, purchase orders"; Inventory receive wording; troubleshooting rows |
| `docs/testing.md` | counts; second shared-numbers pair (`buying_list` ↔ `suggestedBuy`) |
| `docs/deployment.md` | "Applying migrations": SQL editor vs the MCP tool, and why 011 goes through the editor |
| `docs/build-roadmap.md` | batch 4 ✅ with its files; batch 5 note (batch / expiry on GRN lines) |
| `docs/hyperpure-feature-map.md`, `docs/architecture.md` | procurement row and diagram label |
| `docs/adr/README.md`, `docs/adr/0007-inventory-ledger.md` | ADR 0015 in the index; note on 0007 |

## Notes for the owner

* **Why the buying list says "0 to buy" when stock covers tomorrow.** Orders reserve stock when they are
  placed (ADR 0007: an order the warehouse cannot cover is refused), so by the afternoon the day's demand is
  already in stock. The list plans forward: demand × *days of cover* + alert level − free stock − on order.
  Set a low-stock alert level per product (Products → Edit) and the list becomes useful at one day of cover.
  **Open question for you:** should customers be allowed to order beyond stock (buy-to-order)? If yes, the
  availability check in `place_order` becomes a setting (batch 6, Orders +) and this list already shows the
  resulting demand — nothing here changes.
* Receiving stays an **inventory** permission (the warehouse team), planning and ordering are **procurement**
  (the buyer); only `procurement:approve` can send a PO to a supplier.
* The private `purchase-bills` bucket holds mandi bill photos; staff with `inventory:view` get a 10-minute
  signed link from the receipt detail.
