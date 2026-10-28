# Patch guide — Customer self-edit / cancel window (22 Oct 2026)

A customer could edit or cancel their own placed order right up to the slot's cut-off — effectively the rest of the
morning. You asked for a 15-minute window instead, with a per-sector dial. This patch adds exactly that.

**What's new** (migration 017 — **already applied live**):
* **One number per sector.** Settings → Sectors & terms gets an **Edit window (min)** column (0–1440). Defaults:
  Restaurants / Hotels / Retail = 15, Institutions = 60, **Army cantonments & unit messes = 0** (indent-approved
  orders don't get a quiet self-edit; changes go through your team).
* **Customer app** shows "You can still edit or cancel for about X more minutes" on a placed order; when the window is
  spent the two buttons go away and the text says "Call us to make changes." Sector set to 0 shows "Changes and
  cancellations go through our team — please call us" straight away.
* **Database refuses past the window.** `edit_order` and `cancel_order` enforce it so the API cannot be used around the
  UI. Staff (`orders:edit`) are unaffected: still edit until packed, cancel until delivered.
* **`my_order_terms` carries the window** so the app shows the right countdown even when you change the sector dial.

Tested: `npm test` 122/122 · `security_test.sql` 248/248 on a clean local Postgres · all three screens rendered in
headless Chromium (fresh order shows "12 more minutes", stale shows "15-minute window has passed", Sectors shows the
new column with 15 for restaurants and 0 for defence).

**Live project (bzxygscjhvcwahwqgqin):** migration 017 is **already applied**. Confirmed on the live sectors:
restaurant / hotel / retail = 15, institution = 60, defence = 0.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)
1. Unzip `fresh-supply-customer-edit-window.zip` into the repo root — 19 files (3 new, 16 modified). Say **yes** to replacing.
2. `npm test` → `# pass 122`.
3. `git add -A` → `git commit -m "Customer self-edit / cancel window per sector (017)"` → `git push origin main`.
4. Database: **nothing to run** — migration 017 is live. (If you ever rebuild: `supabase/migrations/20261022000002_customer_edit_window.sql` applies through the Supabase tool.)
5. Try it: as a customer, place an order, open it under *My orders* — the notice shows "about 15 more minutes". Change
   the dial under Admin → Settings → Sectors & terms and the countdown updates on the next page load.

## Files — NEW (3)
| Path | What it is |
|---|---|
| `supabase/migrations/20261022000002_customer_edit_window.sql` | migration 017 (applied live) |
| `docs/adr/0021-customer-edit-window.md` | decision record |
| `docs/patches/2026-10-22-customer-edit-window.md` | this guide |

## Files — MODIFIED (12)
| Path | What changed |
|---|---|
| `web/js/pages/restaurant/orders.js` | `canCustomerChange`, `minutesLeftToChange`, the one-line notice; buttons hidden past the window |
| `web/js/pages/admin/sectors.js` | **Edit window (min)** column |
| `web/js/core/api.js` | `saveSectorTerms` carries `customer_edit_window_minutes` (clamped 0–1440; blank = 15) |
| `supabase/tests/security_test.sql` | T62a–f (248 checks total) |
| `tests/pages.test.js`, `tests/unit.test.js`, `tests/helpers/fake-supabase.js` | the existing edit test uses a fresh `created_at` and expects the "X more minutes" notice; three new tests (past the window, defence 0, Sectors save); fixture sectors carry the new field |
| `docs/runbook.md`, `docs/modules/orders-plus.md`, `docs/api.md`, `docs/testing.md`, `docs/build-roadmap.md`, `docs/adr/README.md`, `README.md`, `AGENTS.md`, `CLAUDE.md` | the new column, new RPC field, counts, hotfix row (6a), ADR link |
