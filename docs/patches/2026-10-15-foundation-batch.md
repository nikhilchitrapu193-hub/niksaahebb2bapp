# Patch guide — Phase 1, Batch 1: Foundation (15 Oct 2026)

What this batch adds (build list section 1, Phase 1): cities · warehouses · pin-code service zones ·
stock per warehouse · sectors with trading terms (minimum order, delivery fee, credit days, PO rule) ·
team roles + permission matrix + city / warehouse scope · audit log · CSV export on lists · pin-code
check on the public site · per-city product listing. Plus code rules and three agent skills adapted from
ponytail, pstack, thermos and PentAGI.

Tested: `npm test` 49/49 · `security_test.sql` 85/85 PASS (on a local Postgres 16 built from the
migrations) · every page loaded in headless Chromium without errors.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`)

**Option A — unzip over the project (simplest).**
1. Close the dev server (Ctrl+C in the terminal).
2. Unzip `fresh-supply-foundation-batch.zip` into `C:\Projects\fresh-supply\`. It contains only the files
   listed below, in their folders. Say **yes** to replacing the 33 modified files; the 20 new files are
   just added.
3. In the Cursor terminal: `npm test` → expect `# pass 49`.

**Option B — git apply (keeps a clean diff).**
1. `git checkout -b foundation-batch`
2. `git apply --whitespace=nowarn fresh-supply-foundation-batch.patch`
3. `npm test` → `# pass 49`, then commit.

**Then the database (once, on your Supabase project).**
4. Supabase → SQL editor → paste and run
   `supabase/migrations/20261015000001_foundation_cities_sectors_roles.sql` (or `supabase db push` if you
   use the CLI; or the Supabase MCP `apply_migration` with name `foundation_cities_sectors_roles`).
   It creates "Visakhapatnam" + "Vizag main warehouse", moves every existing customer, order and stock
   figure into them, and makes your existing admin a super admin.
5. Run the last two blocks of `supabase/seed.sql` (the `warehouse_stock` and `service_zones` inserts) —
   or the whole file; it is safe to re-run. This adds sample pin code 530001.
6. Redeploy the Edge Function: `supabase functions deploy invite-staff` (it now accepts `team_role`).
7. Paste `supabase/tests/security_test.sql` into the SQL editor and run it: every line must say PASS.
8. `npm start`, sign in as admin → Settings → Cities & warehouses → add the real pin codes you deliver to.

## Files — NEW (20)

| Path | What it is |
|---|---|
| `supabase/migrations/20261015000001_foundation_cities_sectors_roles.sql` | **NEW** — the whole batch's database: tables, backfill, helpers, RLS, functions |
| `supabase/tests/local_postgres_stub.sql` | **NEW** — run migrations + security test on a plain local Postgres |
| `web/js/core/permissions.js` | **NEW** — `can(me, module, action)`, `visibleNav(me)` |
| `web/js/core/csv.js` | **NEW** — `toCsv()`, `downloadCsv()` for every "Export CSV" button |
| `web/js/pages/admin/locations.js` | **NEW** — Settings → Cities & warehouses & pin codes |
| `web/js/pages/admin/sectors.js` | **NEW** — Settings → Sectors & terms |
| `web/js/pages/admin/roles.js` | **NEW** — Settings → Roles & permissions (tick matrix) |
| `web/js/pages/admin/audit.js` | **NEW** — Audit log viewer with filters and export |
| `docs/adr/0009-cities-warehouses-per-warehouse-stock.md` | **NEW** — decision record |
| `docs/adr/0010-team-roles-permission-matrix-scope.md` | **NEW** — decision record |
| `docs/adr/0011-sectors-and-trading-terms.md` | **NEW** — decision record |
| `docs/adr/0012-audit-log-by-trigger.md` | **NEW** — decision record |
| `docs/build-roadmap.md` | **NEW** — every remaining batch of Phases 1–3 with the files each adds |
| `docs/code-rules.md` | **NEW** — readability rules adapted from ponytail / pstack / thermos / PentAGI |
| `docs/modules/foundation.md` | **NEW** — this module's README (files, rules, what is left) |
| `docs/patches/2026-10-15-foundation-batch.md` | **NEW** — this guide |
| `.cursor/rules/code-rules.mdc` | **NEW** — always-on Cursor rule (short form of code-rules.md) |
| `.cursor/skills/fs-feature/SKILL.md` | **NEW** — `/fs-feature`: build a feature end to end in house order |
| `.cursor/skills/fs-review/SKILL.md` | **NEW** — `/fs-review`: plain-English senior review (ponytail-review + thermos) |
| `.cursor/skills/fs-security-check/SKILL.md` | **NEW** — `/fs-security-check`: RLS / grants / escaping checklist + SQL test |


## Files — MODIFIED (33)

| Path | What changed |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | rules 11–13 (permission + scope, city on every record, code rules & skills); file map |
| `README.md` | apps table, where-things-live, docs links, roadmap |
| `docs/api.md` | every new function and table; audit log section |
| `docs/roles.md` | rewritten: app roles vs team roles, the matrix, scope |
| `docs/runbook.md` | switch on a city, sectors, team roles, approvals needing a warehouse, audit log, troubleshooting |
| `docs/testing.md`, `docs/architecture.md`, `docs/adr/README.md` | counts, diagram, ADR index |
| `supabase/seed.sql` | seeded stock goes into the default warehouse; sample pin code 530001 |
| `supabase/tests/security_test.sql` | setup uses pin codes; T4a/T12g/T12j/T16 updated for MOV fee and per-warehouse stock; T20–T29 added |
| `supabase/functions/invite-staff/index.ts` | accepts and validates `team_role`; only a super admin can invite a super admin |
| `web/js/core/config.js` | `MODULES`, `ACTIONS` |
| `web/js/core/api.js` | wrappers for cities, warehouses, zones, sectors, team roles, permissions, audit, availability, terms, team member, per-warehouse stock; `placeOrder` sends `p_po_reference`; `listOrders` filters |
| `web/js/core/auth.js` | sign-up carries city / pin code / sector; admin users load their permission set |
| `web/js/pages/admin/main.js` | menu from permissions; routes `#locations #sectors #roles #audit`; "No access" guard |
| `web/js/pages/admin/settings.js` | settings tab strip; read-only without settings:edit |
| `web/js/pages/admin/team.js` | app + team role + city / warehouse scope per person; invite sends team role |
| `web/js/pages/admin/customers.js` | sector · city · warehouse shown; **Terms** modal; approve via `set_customer_status`; export |
| `web/js/pages/admin/orders.js` | city / sector filters, PO reference, delivery fee line, export, permission-aware buttons |
| `web/js/pages/admin/inventory.js` | warehouse selector, per-warehouse figures, GRN / adjust into a warehouse, export |
| `web/js/pages/admin/products.js` | "Listed in these cities" ticks; buttons hidden without products:edit |
| `web/js/pages/login.js` | register form: business type, city, pin code |
| `web/js/pages/restaurant/main.js` | cart shows minimum-order warning, delivery fee, PO field; "we do not deliver here yet" banner |
| `web/js/pages/restaurant/cart.js` | `orderPreview()` — same MOV / fee rule as the database |
| `web/js/pages/restaurant/account.js` | city + pin code editing (re-assigns the warehouse) |
| `web/js/pages/landing.js`, `web/index.html`, `web/css/landing.css` | "Do you deliver here?" pin-code check |
| `web/css/components.css` | `.tabs`, `.matrix`, `.diff` styles |
| `tests/helpers/fake-supabase.js` | `upsert`, `in`, `neq`, sign-up recording |
| `tests/unit.test.js` | CSV, permissions, order preview, audit wording |
| `tests/pages.test.js` | fixtures for cities / sectors / roles; 15 new screen tests; admin fixture has `team_role` |

## Behaviour changes to know about

- Orders below the sector minimum (restaurants: ₹2,000) now carry a ₹99 delivery fee; change the numbers
  under Settings → Sectors. Hotels (₹5,000, no fee) are refused below the minimum.
- A customer whose pin code is not in any zone cannot be approved until you set their warehouse
  (Customers → Terms) or add the pin code. Existing customers were attached to the Vizag warehouse.
- `admin_set_user_role` still works, but the Team screen now uses `admin_set_team_member`. Promoting a
  customer to admin without choosing a team role is refused.
- Stock is per warehouse. `receive_stock` / `adjust_stock` take a warehouse (defaults to yours).
- Known shortcut: the Customers → Terms form does not check that the chosen warehouse is in the chosen
  city (`shortcut: trusts the admin, add a trigger when a second city goes live`).
