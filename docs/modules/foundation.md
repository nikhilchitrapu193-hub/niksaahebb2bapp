# Module: Foundation (cities, warehouses, sectors, roles, audit)

Build list section 1, Phase 1. Shipped as migration 006 (`supabase/migrations/20261015000001_foundation_cities_sectors_roles.sql`).

## What it does, in one paragraph
Every order, customer and stock figure belongs to a city and a warehouse. Customers have a sector whose
trading terms (minimum order, delivery fee, credit days, PO rule) drive checkout. Admin-app users have a
team role; a permission matrix and a city / warehouse scope decide what they may do and see. Every change
to prices, orders, payments, people, permissions and settings lands in an audit log.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261015000001_foundation_cities_sectors_roles.sql` |
| Security test | `supabase/tests/security_test.sql` T20–T29 incl. T24i–j (plus updated T4a, T12g, T12j, T16) |
| Seed | `supabase/seed.sql` (per-warehouse stock, sample pin code 530001) |
| Edge Function | `supabase/functions/invite-staff/index.ts` (team_role) |
| Core JS | `web/js/core/config.js` (MODULES, ACTIONS), `permissions.js`, `csv.js`, `api.js`, `auth.js` |
| Admin screens | `web/js/pages/admin/locations.js`, `sectors.js`, `roles.js`, `audit.js`; updated `main.js`, `settings.js`, `team.js`, `customers.js`, `orders.js`, `inventory.js`, `products.js` |
| Customer side | `web/js/pages/login.js` (city, pin code, sector), `restaurant/main.js` (MOV, fee, PO), `restaurant/cart.js` (`orderPreview`), `restaurant/account.js` (delivery area) |
| Public site | `web/index.html` + `web/js/pages/landing.js` (pin-code check), `web/css/landing.css` |
| Tests | `tests/unit.test.js`, `tests/pages.test.js`, `tests/helpers/fake-supabase.js` |
| Docs | `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, ADRs 0009–0012 |

## Business rules (each is one named function)
| Rule | Where |
|---|---|
| A pin code belongs to one warehouse | `service_zones.pincode unique`, `warehouse_for_pincode()` |
| New customers get the warehouse of their pin code, else none | `handle_new_user()` |
| A customer without a warehouse cannot be approved or order | `set_customer_status()`, `place_order()` |
| Below the minimum order: charge the fee, or refuse if the fee is 0 | `place_order()`; mirrored by `orderPreview()` in `cart.js` |
| Sectors with `needs_po_reference` must give a PO number | `place_order()` |
| Stock is reserved in the customer's warehouse; totals stay in step | `apply_stock_movement()` |
| A product hidden in a city is invisible and unorderable there | `products_select` policy, `place_order()` |
| What a team role may do | `has_permission()`; matrix in `role_permissions` |
| Which rows a team member sees | `in_my_scope()` in policies and functions |
| Only a super admin can change the matrix or grant super admin | `role_permissions_super_admin_write` policy, `admin_set_team_member()` |
| Every change to key tables is logged with who / when / what | `write_audit_log()` trigger |

## Not in this batch (still Phase 1)
Phone-OTP login, logistics-partner login, document upload, sort/filters and pack sizes in the catalogue,
slot capacity, the pricing engine, procurement (POs, QC at receiving), pick lists, proof of delivery,
cash settlement, online payments, credit limits, statements, reports. See `docs/build-roadmap.md`.
