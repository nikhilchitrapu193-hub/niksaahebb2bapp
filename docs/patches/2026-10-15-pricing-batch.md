# Patch guide — Phase 1, Batch 2: Pricing engine + all sectors on sign-up (15 Oct 2026)

Two things in one patch:

1. **Fix: the sign-up form offered 2 of the 5 sectors.** Migration 006 had seeded `can_self_register`
   on for restaurants and hotels only. Migration 008 turns it on for every sector (the tick under
   Settings → Sectors & terms still switches one off); the form label became "Business / outlet name"
   and shows the chosen sector's terms as a hint; the customer app's label is now "Customer" instead of
   "Restaurant partner". A standing rule was added so this cannot happen again: **docs/code-rules.md
   rule 7 "A change lands everywhere the thing appears"**, mirrored in `.cursor/rules/code-rules.mdc`,
   AGENTS.md / CLAUDE.md rule 14, and as step 5 (consistency sweep) of the `/fs-feature` skill.
2. **Batch 2, the pricing engine** (migration 009): HSN codes, pack sizes, pricing rules per category
   with effective dates, per-product overrides, benchmarks (manual + CSV), price history, weighted-average
   cost, the price board with margin guard and scheduled changes, HSN on invoices, cost snapshot per
   order line, catalogue prices incl./excl. GST. Full description: `docs/modules/pricing.md`, ADR 0013.

Tested: `npm test` 64/64 · `security_test.sql` 121/121 PASS on a local Postgres 16 built from the
migrations · every new screen rendered in headless Chromium without errors.

**Status on the live project (bzxygscjhvcwahwqgqin), 15 Oct 2026:** migrations 008 and 009 are applied,
pg_cron is enabled with the `publish-due-prices` job every 5 minutes, and the live formula gives the same
numbers as the tests. No seed data was pushed live (the sample supplier quotes in `seed.sql` are
placeholders); the board shows "No cost on file" until you enter quotes or receive stock with costs.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, branch from `main`)

1. `git checkout -b pricing-batch`
2. Unzip `fresh-supply-pricing-batch.zip` into `C:\Projects\fresh-supply\` — 41 files (9 new, 32 modified),
   in their folders. Say **yes** to replacing.
3. `npm test` → `# pass 64`.
4. `git add -A` → `git commit -m "Phase 1 batch 2: pricing engine; all sectors on sign-up"` →
   `git push -u origin pricing-batch` → open the pull request on GitHub and merge.
5. Database: nothing to do — both migrations are already live. (Only if you ever rebuild the database:
   `supabase/migrations/` in order, then `supabase/seed.sql`, then `supabase/tests/security_test.sql`
   → 121 PASS. The seed's "UPDATE without WHERE" warning is the same harmless one as last time.)
6. `npm start`, sign in as admin: a **Pricing** menu item appears (super admin, pricing manager, city
   manager; buyers see the board and benchmarks). Follow "Prices: the morning routine" in
   `docs/runbook.md`: Benchmarks → type today's rates; Price board → type supplier quotes, tick rows,
   Publish. Products → Edit now has HSN code and "one unit holds".

## Files — NEW (9)

| Path | What it is |
|---|---|
| `supabase/migrations/20261015000003_sectors_open_sign_up.sql` | **NEW** — migration 008: every sector may self-register (already live) |
| `supabase/migrations/20261015000004_pricing_engine.sql` | **NEW** — migration 009: the whole pricing engine (already live) |
| `web/js/core/pricing.js` | **NEW** — the formula in JS (`computePrice`, `roundPrice`, `marginOf`, `sparklinePath`), mirror of `compute_price_from()` |
| `web/js/pages/admin/price-board.js` | **NEW** — Pricing → Price board, publish dialog, per-product drawer (explain / override / history) |
| `web/js/pages/admin/pricing-rules.js` | **NEW** — Pricing → Rules (per category, effective dates, test box) |
| `web/js/pages/admin/benchmarks.js` | **NEW** — Pricing → Benchmarks (grid entry, CSV upload, sources) |
| `docs/modules/pricing.md` | **NEW** — the module README: formula, tables, rules, permissions, starting values |
| `docs/adr/0013-pricing-engine-rules-and-board.md` | **NEW** — decision record |
| `docs/patches/2026-10-15-pricing-batch.md` | **NEW** — this guide |

## Files — MODIFIED (32)

| Path | What changed |
|---|---|
| `supabase/seed.sql` | HSN + pack sizes for the sample catalogue, category rules, egg / chicken overrides, sample supplier quotes |
| `supabase/tests/security_test.sql` | T2e, T21b (all sectors), T30–T39 (formula, RLS, board, benchmark cap, publish, margin guard, picker, pricing manager, scheduling, snapshots, weighted average) — 121 checks |
| `web/js/core/config.js` | `MODULES.pricing`, `PACK_UNITS`, `PRICING_MODES`, `COST_METHODS`; customer label "Customer" |
| `web/js/core/api.js` | Pricing section (board, publish, rules, overrides, quotes, sources, benchmarks, history, HSN); `saveProduct` keeps a board price |
| `web/js/core/csv.js` | `parseCsv()` for uploads |
| `web/js/pages/admin/main.js` | routes `#pricing #pricing-rules #benchmarks`; parent-route highlighting |
| `web/js/pages/admin/products.js` | HSN code (fills GST rate), "one unit holds", price / market price read-only when published from the board |
| `web/js/pages/admin/settings.js` | "Show catalogue prices including GST" |
| `web/js/pages/login.js` | all self-registering sectors, sector hint, "Business / outlet name" |
| `web/restaurant/login.html` | page title |
| `web/js/pages/restaurant/catalogue.js` | `displayPrice()` (incl./excl. GST), benchmark source and date next to the market rate |
| `web/js/pages/restaurant/main.js` | loads company settings for the catalogue |
| `web/js/pages/landing.js` | benchmark label on the public cards |
| `web/js/pages/invoice.js` | HSN column, delivery fee line |
| `web/css/components.css` | board, flags, rule cards, sparkline; modal text alignment fix |
| `tests/helpers/fake-supabase.js` | `gte` / `lte` filters, upsert returns rows |
| `tests/unit.test.js` | formula (same numbers as SQL T30), rounding, CSV parsing, benchmark import, rule picker, GST display |
| `tests/pages.test.js` | fixtures for rules / sources / board; 8 new screen tests (sign-up sectors, board, no-access, rules, benchmarks, product form, catalogue, invoice) |
| `AGENTS.md`, `CLAUDE.md` | rules 14 (change lands everywhere) and 15 (prices come from the formula); file map |
| `.cursor/rules/code-rules.mdc` | rule 7 |
| `.cursor/skills/fs-feature/SKILL.md` | step 5: consistency sweep |
| `docs/code-rules.md` | rules 7 and 8 |
| `docs/api.md` | pricing functions and tables; audit list |
| `docs/roles.md` | `pricing` module and its four actions |
| `docs/runbook.md` | the morning routine, products, troubleshooting |
| `docs/testing.md` | counts; the two-copies rule |
| `docs/architecture.md` | pricing diagram |
| `docs/build-roadmap.md` | batch 2 ✅; migration numbers; price lists moved to batch 3 |
| `docs/adr/README.md` | ADR 0013 |
| `docs/modules/foundation.md` | note on migrations 007 / 008 |
| `README.md` | admin app row, file tree, roadmap |

## Behaviour changes to know about

- Prices published from the board are read-only on the product form (`price_source = 'rule'`); hand-priced
  products are unchanged.
- Customers now see "Best rate · save 12% vs Rythu Bazaar board · 15 Oct" when a benchmark was used.
- Order lines carry an HSN code and (staff-only) a landed-cost snapshot; invoices show HSN and the delivery fee.
- Known shortcuts: `pricing_inputs()` runs per product (fine below ~2,000 active products); price lists
  per city / sector come in batch 3; the landed-cost / yield / margin calculators live in the board's
  product drawer rather than as separate screens.
