# API reference

All write operations are Postgres functions in `supabase/migrations/20261005000003_functions_and_storage.sql`,
called via `supabase.rpc(name, args)` and wrapped in `web/js/core/api.js`.
All require a signed-in user; each re-checks the role and raises `42501` (permission denied) otherwise.

## Functions

| Function | Who | Arguments | Returns |
|---|---|---|---|
| `place_order` | approved restaurant | `p_items jsonb` `[{product_id, quantity}]`, `p_notes`, `p_delivery_date date`, `p_delivery_slot` (morning/afternoon/evening/express), `p_payment_method` (cod/credit) | `{id, order_number, total_amount}` |
| `set_order_status` | admin, restaurant (cancel own), driver (assigned) | `p_order_id uuid`, `p_new order_status`, `p_note text` | – |
| `assign_delivery` | admin | `p_order_id`, `p_delivery_user uuid` | – |
| `admin_list_users` | admin | – | rows: id, email, role, full_name, phone, is_active, restaurant_name, restaurant_status, created_at |
| `admin_set_user_role` | admin | `p_user`, `p_role`, `p_active` | – |
| `update_my_profile` | any | `p_full_name`, `p_phone` | – |
| `update_my_restaurant` | restaurant | `p_name`, `p_address`, `p_phone`, `p_gstin` | – |
| `admin_dashboard_stats` | admin | – | `{orders_today, revenue_today, revenue_7d, pending_restaurants, open_orders_by_status, top_products_30d}` |
| `receive_stock` | admin | `p_items jsonb` `[{product_id, quantity, unit_cost}]`, `p_supplier_id`, `p_note` | – (adds stock, writes `received` movements) |
| `adjust_stock` | admin | `p_product_id`, `p_new_qty`, `p_reason` (adjustment/wastage/returned), `p_note` | – (sets exact count) |
| `set_order_payment` | admin | `p_order_id`, `p_status` (paid/unpaid) | – |
| `admin_outstanding_balances` | admin | – | rows: restaurant_id, outstanding, unpaid_orders |
| `claim_first_admin` | any signed-in user | – | `true` if the caller became the first admin; `false` once any admin exists |

`update_my_restaurant` also takes `p_fssai`. `apply_stock_movement` is internal (not callable from the API):
every change to `products.stock_qty` goes through it and leaves a row in `stock_movements`.

### Business rules inside `place_order`
* Caller must be a restaurant that is `approved` and has a delivery address.
* Rejects empty carts and more than 100 lines; merges duplicate products.
* Rejects inactive or out-of-stock products, and quantities below `min_order_qty` or above 10,000.
* Prices and GST rates come from the database, never from the client; the order snapshots name, unit, price and GST rate.
* Quantity must not exceed `stock_qty`; the product row is locked while checking, and the stock is reserved (movement `order`). Cancelling returns it (`order_cancelled`).
* Express slot = delivered today; other slots need a date from tomorrow up to 7 days ahead.
* `subtotal`, `tax_amount` (sum of line taxes, rounded per line) and `total_amount` are stored on the order.
* Everything happens in one transaction: either the whole order is created or nothing is.

### Allowed status transitions
See the diagram in [architecture.md](architecture.md#order-lifecycle).

## Tables readable from the browser (RLS applies)

`profiles` (own row; admin all) · `restaurants` · `categories` · `products` · `orders` · `order_items` · `order_status_history` ·
`company_settings` (all signed-in) · `suppliers` and `stock_movements` (admin only).
Logged-out visitors (`anon`) may read `categories` and listed `products` for the public landing page.
Admins can write `products`, `categories`, `suppliers`, and update `restaurants` and `company_settings` directly.

## Edge Functions

| Function | Who | Body | Does |
|---|---|---|---|
| `invite-staff` | admin (JWT checked server-side) | `{ email, role: 'admin'\|'delivery', full_name, redirect_to }` | Sends a Supabase invite email and sets the new profile's role. Source: `supabase/functions/invite-staff/index.ts`. |

## Storage

Bucket `product-photos` (public read, 5 MB, JPEG/PNG/WebP). Only admins can upload, replace or delete.

## Errors

Database errors surface as `Error.message`; `api.js` maps common codes
(`23505` duplicate, `23503` in use, `42501` forbidden) to friendly text.
