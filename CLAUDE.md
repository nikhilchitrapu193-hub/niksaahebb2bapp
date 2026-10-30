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

---

## Current build state (updated 2026-10-30)

### Repository
- **GitHub**: `nikhilchitrapu193-hub/niksaahebb2bapp`
- **Latest commit**: `8497471` — super-admin reset feature
- **Supabase project ID**: `bzxygscjhvcwahwqgqin`

### Applied migrations (24 total — all on live DB)
| File | What it does |
|------|-------------|
| 20261005000001_core_schema.sql | Base tables: profiles, restaurants, outlets, products, categories, orders, order_items |
| 20261005000002_auth_and_rls.sql | RLS policies, `app_role()`, `has_permission()`, `in_my_scope()` |
| 20261005000003_functions_and_storage.sql | `place_order()`, `update_stock()`, storage buckets |
| 20261005000004_inventory_and_checkout.sql | Inventory helpers, checkout flow |
| 20261005000005_first_admin.sql | Bootstrap first admin user |
| 20261015000001 | Cities, warehouses, sectors, team roles, role_permissions, `queue_notification()` |
| 20261015000002 | Revoke anon on inventory tables |
| 20261015000003 | Sectors open sign-up |
| 20261015000004 | Pricing engine: pricing_rules, product_pricing, benchmark_sources, `compute_price_from()`, `apply_prices()` |
| 20261015000005 | Catalogue+: HSN, pack sizes, price lists, `customer_price()`, `my_price_list()` |
| 20261015000006 | Procurement: purchase_orders, goods_receipts, stock_movements, `receive_goods()`, `buying_list()` |
| 20261015000007 | Fulfilment: trips, vehicles, drivers, trip_orders, `dispatch_trip()`, `complete_delivery()` |
| 20261015000008 | Orders+: order_status_history, order_line_costs, delivery_returns, `place_order_core()` |
| 20261020000001 | Launch control: `company_settings.pricing_mode` / `stock_mode`, `sectors.is_active` |
| 20261020000002 | Payments+credit: payments, payment_allocations, credit_notes, debit_notes, `record_payment()`, `allocate_payment()` |
| 20261022000001 | Customer access: `customer_users`, invite edge function, `my_restaurant_id()` |
| 20261022000002 | Customer edit window: `sectors.customer_edit_window_minutes`, `can_edit_order()` |
| 20261027000001 | Notifications+support: notifications, support_tickets, ticket_messages, `send_notification()` |
| 20261027000002 | Reports+dashboard: sales report views, `sales_report()` |
| 20261028000001 | Customer organisation: approval workflows, `orders.approval_status`, standing orders, quotes, coupons |
| 20261028000002 | Ordering+: bulk order, ordering plus features in restaurant app |
| 20261029000001 | Support channels full: full support ticket lifecycle |
| 20261030000001 | Delivery photos: `trips.pre_departure_photo_path`, `record_trip_departure()`, `trip-photos` bucket |
| 20261030000002_super_admin_reset.sql | `reset_test_data()` — **WRITTEN but NOT YET APPLIED to live DB. User must paste SQL manually.** |

### ⚠️ Pending manual DB action
Migration 024 (`20261030000002_super_admin_reset.sql`) is in the repo but **not applied**.
The user must paste it at: https://supabase.com/dashboard/project/bzxygscjhvcwahwqgqin/sql/new
The file is at `supabase/migrations/20261030000002_super_admin_reset.sql`.

### Key DB function signatures (call these exactly)
```sql
-- Role checks (no uid argument — uses auth.uid() internally)
app_role()                              → text  ('admin'|'restaurant'|'delivery')
is_super_admin()                        → bool  (role='admin' AND team_role='super_admin')
has_permission(p_module text, p_action text) → bool
in_my_scope(p_city_id uuid, p_warehouse_id uuid) → bool
my_restaurant_id()                      → uuid  (owner or member of a restaurant)

-- WRONG — never pass auth.uid() as first arg:
-- has_permission(auth.uid(), 'orders', 'view')  ← WRONG
-- has_permission('orders', 'view')               ← CORRECT

-- Orders
place_order_core(p_outlet_id, p_items jsonb, p_delivery_date, p_notes)  → uuid (order_id)
restaurant_for_outlet(p_outlet_id uuid)  → uuid (restaurant_id)

-- Stock / procurement
receive_goods(p_po_id, p_items jsonb, p_warehouse_id, p_received_at)
adjust_stock(p_product_id, p_warehouse_id, p_qty_delta, p_reason)

-- Fulfilment
dispatch_trip(p_trip_id uuid)
complete_delivery(p_order_id uuid, p_otp text, p_pod_photo_path text)
record_trip_departure(p_trip_id uuid, p_photo_path text)

-- Payments
record_payment(p_restaurant_id, p_amount, p_method, p_reference, p_notes)
allocate_payment(p_payment_id, p_order_ids uuid[])

-- Notifications
queue_notification(p_event text, p_restaurant_id uuid, p_order_id uuid, p_data jsonb)

-- Pricing
compute_price_from(p_cost numeric, p_rule_id uuid)  → numeric
apply_prices(p_product_ids uuid[], p_price_list_id uuid)

-- Super-admin only
reset_test_data()  → jsonb  (wipes all transactional data; keeps config/products/users)

-- Trigger function — NOT callable directly:
-- write_audit_log()  ← fires automatically on UPDATE/INSERT/DELETE
```

### Storage buckets
| Bucket | Access | Used for |
|--------|--------|---------|
| `product-photos` | **Public** | Product catalogue images (use `getPublicUrl`) |
| `purchase-bills` | Private | PO and supplier bills (use signed URLs) |
| `delivery-pod` | Private | Proof-of-delivery photos |
| `customer-documents` | Private | Customer FSSAI/GST uploads |
| `trip-photos` | Private | Pre-departure loading photos |

### Super-admin accounts
Both Nikhil and Saaheb have `profiles.team_role = 'super_admin'`. No separate column needed.
`is_super_admin()` checks `role = 'admin' AND team_role = 'super_admin'` on the profiles table.

### Edge functions deployed
- `customer-access` — token-gated customer portal link
- `customer-users` — create customer users
- `invite-staff` — email invites for admin/delivery staff
- `razorpay-order` + `razorpay-webhook` — Razorpay integration (needs key config)
- `send-notifications` — SMS/email dispatch

### Go-live blockers (as of 2026-10-30)
- 🔴 Razorpay keys: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` edge function secrets + `razorpayKeyId` in `config.js`
- 🔴 SMS/email provider secrets for `send-notifications` edge function
- 🟡 Static hosting: serve `web/` from Cloudflare Pages / Netlify (no build step)
- 🟡 Seed data: city, warehouse, product, admin user, launch mode config
- 🟡 Supabase SMTP for staff invite emails
- 🟡 Production domain in Auth → URL Configuration

### What was REMOVED (do not re-add)
- Fleetbase integration (deleted: edge functions, `fleetbase-trips.js`, phase-2 migration stubs)
- PWA service worker (`manifest.json`, `sw.js`) — conflicted with ES module approach; add later
- Supplier portal — removed, scope reduced for MVP
- Warehouse management page (`warehouse.js`) — deleted in Fleetbase cleanup

### Critical patterns that are easy to get wrong
1. `write_audit_log()` is a **trigger**, not a callable function — never call it directly
2. `has_permission` takes **2 args** (module, action) — no uid arg
3. SECURITY DEFINER functions must have `SET search_path = ''` to prevent search_path injection
4. Never `UPDATE orders SET payment_status` — use `sync_order_payment_status()` which derives it
5. Never `UPDATE products SET stock_qty` — use `receive_goods()` / `adjust_stock()`
6. The Supabase MCP tool `execute_sql` will **cancel** any SQL with DELETE statements — apply destructive migrations manually in the Supabase SQL editor
7. Product photos bucket is **public** — use `supabase.storage.from('product-photos').getPublicUrl(path)`. All other buckets are private — use signed URLs.
8. `config.js` in `web/` must NEVER contain service-role or secret keys — security is in RLS + SECURITY DEFINER functions
