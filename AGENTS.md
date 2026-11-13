# Instructions for coding agents (Codex, Cursor, Claude Code)

Read this first, then the docs it points to. Do not guess at the architecture.

## What this project is
Fresh Supply: a Hyperpure-style B2B food supply platform. Public site + restaurant app +
admin app (with warehouse/inventory) + delivery app. Plain HTML/CSS/ES modules in `web/`,
Supabase Postgres as the backend (`supabase/`). No framework, no build step, no AI in the app.

## Read before changing anything
| Task | Read |
|---|---|
| Any change | `README.md`, `docs/architecture.md`, `docs/contributing.md`, `docs/code-rules.md` |
| Database, permissions, business rules | `docs/api.md`, `docs/roles.md`, `supabase/migrations/*.sql` (in order) |
| Why things are the way they are | `docs/adr/README.md` and the ADR it links |
| Product scope / what Hyperpure does | `docs/hyperpure-feature-map.md` |
| What to build next, in which order | `docs/build-roadmap.md` |
| Cities, sectors, roles, audit (migration 006) | `docs/modules/foundation.md` |
| Prices, benchmarks, HSN, margin guard (migration 009) | `docs/modules/pricing.md` |
| Category tree, pack sizes, loose weight, price lists (migration 010) | `docs/modules/catalogue.md` |
| Launch switches: live sectors, simple / advanced pricing, simple / counted stock (migration 014) | `docs/modules/launch-control.md` |
| Receipts, allocation, credit limits, ageing, statements, Razorpay (migration 015) | `docs/modules/payments.md` |
| A customer stuck at the confirmation email: resend, confirm, link, temporary password (migration 016) | `docs/runbook.md` → "When a customer cannot sign in", ADR 0020 |
| Customer self-edit / cancel window per sector (migration 017) | `sectors.customer_edit_window_minutes`, ADR 0021 |
| Running, deploying, first admin | `docs/runbook.md`, `docs/deployment.md` |
| Tests | `docs/testing.md` |
| What a screen does, who uses it, what it touches, repo vs live, impact of a change | `npm run atlas` → `appatlas/out/index.html`; how it works: `docs/appatlas.md`, ADR 0026 |

## Rules that must not be broken
1. **Pages never call Supabase directly.** All backend calls go through `web/js/core/api.js`.
2. **Build markup only with the `html` tagged template** from `web/js/core/ui.js` (it escapes
   user data). Never concatenate strings into `innerHTML`.
3. **Security lives in the database.** Writes to orders, stock, users go through SQL functions
   that re-check the caller's role. UI checks are convenience only. Never put a secret or
   service-role key in `web/`.
4. **Never edit an applied migration.** Add a new file `supabase/migrations/2026MMDDNNNNNN_name.sql`
   and apply it. Add a matching check to `supabase/tests/security_test.sql`.
5. **Stock is a ledger.** Change `products.stock_qty` only via `receive_goods` / `adjust_stock`
   (see ADR 0007). Never `update products set stock_qty`.
6. **Orders snapshot prices.** Never recompute old orders from current product prices.
7. **No frameworks, no bundlers, no TypeScript, no new npm runtime dependencies.**
   The only dev dependency is jsdom for tests.
8. **Every file starts with a header comment saying what it is for.** Comment the *why*.
9. **Run `npm test` before finishing.** Add a test for every new screen or helper. `tests/schema.test.js` checks every
   table / column / function name in `web/js` against the live schema snapshot (`tests/fixtures/live-schema.json`);
   after applying a migration refresh it with `supabase/tests/schema_snapshot.sql`. Never guess a name — read the migration.
10. **Update the docs** (`docs/api.md`, `docs/roles.md`, an ADR for significant decisions)
    in the same change.
11. **Permission and scope, not "is admin".** Admin-app functions and policies check
    `has_permission(module, action)` and `in_my_scope(city_id, warehouse_id)` (migration 006). The
    browser hides buttons with `can(me, module, action)` from `web/js/core/permissions.js`; new modules
    or actions go into `config.js` MODULES / ACTIONS *and* the `role_permissions` check constraints.
12. **Every operational record carries `city_id` / `warehouse_id`.** Stock changes name a warehouse.
13. **Smallest complete change, plain comments, plain words** — `docs/code-rules.md`. Use the project
    skills: `/fs-feature` to build, `/fs-review` to review, `/fs-security-check` before finishing.
14. **A change lands everywhere the thing appears.** Lists from a table (sectors, cities, roles, HSN codes,
    benchmark sources) show every active row on every screen; a filter must be a named rule the admin can
    see and change. Grep what you changed and walk every hit before finishing (code-rules rule 7).
15. **Prices come from the formula.** `compute_price_from()` in SQL and `computePrice()` in
    `web/js/core/pricing.js` are the same formula; change both and the shared test numbers (T30 ↔
    `tests/unit.test.js`). Publishing goes through `apply_prices()`; never `update products set price`
    from a screen (the product form only edits hand-priced products).
16. **A pack size is a product; a customer's price is `customer_price()`.** Never add a second price or
    stock column: variants are rows with `parent_product_id`; price lists are a layer resolved by the
    database (`my_price_list()` for the customer app). Billing on packed weight goes through
    `set_packed_quantities()`, never `update order_items`.
17. **Every receipt is a GRN.** Goods come in only through `receive_goods()` (migration 011) — against a
    PO, as a mandi cash purchase or a direct delivery — and the browser has one receive form
    (`grn.js` `receiveForm`) opened from Purchase orders, Receipts and Inventory. A purchase order is a
    plan: it never writes stock. The buying-list arithmetic is `buying_list()` ↔ `suggestedBuy()`
    (`web/js/core/procurement.js`), shared test numbers T45 ↔ `tests/unit.test.js`.
18. **Money is open items.** A delivered order is the invoice; receipts and credit notes reach it only through
    `payment_allocations`, written by `record_payment()` / `allocate_payment()` / the allocator (migration 015). Never
    `update orders set payment_status`: `sync_order_payment_status()` derives it, and every paid order has a receipt.
    Voiding is a flag, never a DELETE. The cart's oldest-due-first preview (`fifoAllocate`) mirrors `allocate_customer_credits()`.
19. **Launch modes hide, they never grant.** Settings → Launch (`company_settings.pricing_mode` / `stock_mode`,
    `sectors.is_active`) decides what the admin menu shows (`web/js/core/launch.js`) and what the database enforces
    (a sector that is off cannot order; simple stock never reserves). The permission matrix still applies on top. New
    screens for pricing / inventory / procurement must sit under those modules so the switches reach them.
20. **Messages are queued, never sent from the app.** Anything a customer should hear about goes through
    `queue_notification()` into the `notifications` outbox (a trigger or a database function queues it); only the
    `send-notifications` Edge Function talks to a provider, behind its one `send(row)` interface. New events = a row in
    `NOTIFICATION_EVENTS` (`config.js`), the `notification_settings.event` check, a seeded default template, and the
    trigger / function that queues it. Template rendering is `render_template()` ↔ `renderTemplate()` (`notify.js`)
    with shared test strings. Phone numbers normalise through `phone_for_sms()` ↔ `phoneDigits()`.
21. **The account is the commercial unit; outlets and members hang off it.** Terms, credit, balance and statements
    belong to the `restaurants` row; `outlets` are delivery points and `customer_users` are logins with a role
    (migration 020). Anything customer-side keys on `my_restaurant_id()` (owner or member) — never on `owner_id` —
    and an order carries `outlet_id`. Approval before dispatch is `orders.approval_status`, not an order status:
    a held order is a placed order the kitchen may not confirm. New order paths go through `place_order_core`
    with `restaurant_for_outlet()`; never copy the core.
22. **Keep the atlas in step.** A new route needs `appatlas/annotations/<feature-id>.yaml`
    (`node tools/appatlas/cli.js annotate <id>` writes a draft); a new known problem goes into
    `appatlas/troubleshooting.yaml` and the runbook. `npm test` fails on an invalid annotation; `npm run atlas:check`
    lists reviewed guides your change made stale. After applying a migration or deploying an Edge Function, refresh
    `appatlas/live-state.json` (`supabase/tests/appatlas_snapshot.sql`). AppAtlas never calls AI; drafts are labelled.

## Where things live
```
web/index.html                 public landing page
web/<role>/login.html          per-role login (shared module web/js/pages/login.js)
web/<role>/index.html          app shell; routes in web/js/pages/<role>/main.js
web/js/core/                   config, supabase client, auth, api, ui, shell/router, permissions, csv, csv-import, pricing, catalogue, procurement, fulfilment, launch, receivables
web/js/pages/<role>/*.js       one module per screen (admin: …006/009/010; buying-list, purchase-orders, grn, rate-cards in 011; fulfilment, trips, driver-cash, delivery-charges, slots, issues in 012/013; launch in 014; payments in 015; restaurant: product page, order edit/cancel/issue, payments; delivery: POD completion); web/js/pages/po.js + web/po.html print a PO; statement.js + statement.html print an account statement
web/css/                       base.css (tokens), components.css, landing.css
supabase/migrations/           schema → … → procurement (011) → fulfilment (012) → orders + (013) → launch control (014) → payments & credit (015) → customer access (016) → customer edit window (017), in order
supabase/seed.sql              sample catalogue
supabase/tests/security_test.sql   paste into Supabase SQL editor; every line must PASS
supabase/tests/local_postgres_stub.sql  lets the same test run on a plain local Postgres
.cursor/rules, .cursor/skills  code rules and the fs-feature / fs-review / fs-security-check skills
tests/                         node --test; fake Supabase client in tests/helpers/
tools/appatlas/                AppAtlas engine (scanners, graph, site, CLI) — docs/appatlas.md
appatlas/                      annotations/*.yaml, troubleshooting.yaml, live-state.json, review-lock.json (out/ is generated)
```

## How to add a feature (the usual order)
1. Migration (tables/columns/functions + RLS) → apply in Supabase → security test case.
2. Wrapper in `web/js/core/api.js`.
3. Screen module in `web/js/pages/<role>/`, route + nav link in that role's `main.js`.
4. Test in `tests/pages.test.js` using `setup({ session, profile, tables, rpc })`.
5. Docs: `docs/api.md`, `docs/roles.md`, runbook if it changes how staff work, ADR if it is a decision.

## Environment
Node 20+, Windows-friendly (no shell scripts). `npm start` serves `web/` at http://localhost:3000.
Supabase project URL and publishable key are in `web/js/core/config.js`. The sandboxed test
runner cannot reach Supabase; page tests use the fake client.
