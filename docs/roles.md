# Roles & permissions

Two things decide what a login can do:

1. **App role** (`profiles.role`: `restaurant`, `admin`, `delivery`) — which app they sign in to.
2. **Team role** (`profiles.team_role`, admin-app users only) — what they may do inside the admin app,
   through the permission matrix below. Plus a **scope** (`profiles.city_id`, `profiles.warehouse_id`):
   which rows they see. `NULL` = all cities / all warehouses.

The database enforces all of it (`has_permission()`, `in_my_scope()`, RLS policies, migration 006).
The browser only hides buttons and menu items (`web/js/core/permissions.js`).

## Customers and drivers

| Capability | Customer (`restaurant`) | Driver (`delivery`) |
|---|:-:|:-:|
| Browse products listed in their city | ✅ (once signed in) | – |
| Place order (approved, has a warehouse, meets sector terms) | ✅ | – |
| See orders | own | assigned to them |
| Cancel order | own, while `placed` | – |
| Dispatch / deliver | – | assigned orders |
| Edit own details, city and pin code | ✅ | – |
| View / print GST invoice | own orders | – |

Logged-out visitors can browse the public catalogue, read the city and sector lists, and check a pin code.

## Team roles (admin app)

| Team role | Meant for |
|---|---|
| `super_admin` | The owner. Every permission, every city. Only a super admin can grant or remove super admin, or change the matrix. |
| `city_manager` | Runs one city (scope = city). |
| `warehouse_manager` | Runs one warehouse (scope = warehouse). |
| `procurement_buyer` | Buys and records receipts; types the morning mandi rates (pricing: view, edit). |
| `pricing_manager` | Sets and approves prices (pricing: view, edit, approve, export). |
| `finance` | Payments, credit, invoices. |
| `sales` | Signs up and approves customers, sets their terms. |
| `support` | Edits and cancels orders. |
| `dispatcher` | Assigns drivers, dispatches. |
| `picker` | Packs orders. |
| `driver` | Delivery app only; no admin permissions. |

The list lives in `team_roles`; add a role with a migration, then tick its boxes on Settings → Roles.

## The permission matrix

Modules: dashboard, orders, products, inventory, customers, payments, team, settings, audit, reports, pricing (migration 009).
Actions: **view**, **edit** (create / change), **approve**, **export**. A tick = allowed.
Super admin needs no ticks. Starting ticks are seeded by migration 006; the owner changes them on
Settings → Roles & permissions (`role_permissions` table).

Where each permission is checked:

| Permission | Lets you |
|---|---|
| `dashboard:view` | open the dashboard (`admin_dashboard_stats`) |
| `orders:view` / `orders:edit` | see orders in scope / move status, assign drivers, cancel |
| `orders:export` | download the order list as CSV |
| `products:view` / `products:edit` | see / change products, categories, photos, per-city listing |
| `inventory:view` / `inventory:edit` / `inventory:export` | see stock & suppliers / receive, adjust, write off / export |
| `customers:view` / `customers:edit` / `customers:approve` / `customers:export` | see / change sector, area, terms / approve or suspend / export |
| `payments:edit` | mark orders paid or unpaid |
| `team:view` / `team:edit` | list the team / invite, change roles and scope |
| `settings:view` / `settings:edit` | see / change company details, cities, warehouses, pin codes, sector terms |
| `audit:view` / `audit:export` | read / export the audit log |
| `reports:*` | reserved for the reports batch |
| `pricing:view` / `pricing:edit` / `pricing:approve` / `pricing:export` | open the price board, rules, benchmarks, history / enter benchmarks and quotes, change rules and overrides / publish, schedule and cancel prices / export |

## Scope

`in_my_scope(city_id, warehouse_id)` is true when the row's city matches the person's city (or they have none)
and the row's warehouse matches their warehouse (or they have none). It filters `orders`, `restaurants`,
`stock_movements`, `warehouse_stock`, the dashboard and outstanding balances, and is re-checked by every
function that changes an order, a customer or stock.

**Login areas:** `/restaurant/login.html` (sign in + register), `/admin/login.html` and `/delivery/login.html` (sign in only).
An account that signs in on the wrong page is signed out with a hint; the database enforces the real restriction.

**Customer status:** `pending` (default) → `approved` → optionally `suspended`. Approval needs a warehouse.
**Deactivated users** (`is_active = false`) see nothing and are signed out of the apps.

## Adding a new app role

1. Add the value to the `user_role` enum in a new migration.
2. Extend RLS policies and role checks in the relevant functions.
3. Add an entry to `ROLE_HOME` in `web/js/core/config.js` and a new `web/<role>/` app.
4. Add cases to `supabase/tests/security_test.sql`.

## Adding a new module or action to the matrix

1. New migration: extend the check constraints on `role_permissions.module` / `.action`.
2. Add it to `MODULES` / `ACTIONS` in `web/js/core/config.js` (they must match).
3. Check it in the database function or RLS policy that guards the feature (`has_permission('x', 'y')`).
4. Add a security test case.
