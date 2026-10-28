# API reference

All write operations are Postgres functions (migrations 003, 004, 005, 006, 009, 010, 011, 012, 013, 014, 015 and 016 in `supabase/migrations/`),
called via `supabase.rpc(name, args)` and wrapped in `web/js/core/api.js`.
All require a signed-in user; each re-checks the role and raises `42501` (permission denied) otherwise.
Since migration 006, admin-app functions check a **permission** (`has_permission(module, action)`, see
[roles.md](roles.md)) and a **scope** (`in_my_scope(city_id, warehouse_id)`) instead of plain "is admin".

## Functions

| Function | Who | Arguments | Returns |
|---|---|---|---|
| `place_order` | approved customer with a warehouse | `p_items jsonb` `[{product_id, quantity}]`, `p_notes`, `p_delivery_date date`, `p_delivery_slot` (morning/afternoon/evening/express), `p_payment_method` (cod/credit), `p_po_reference text` | `{id, order_number, total_amount, delivery_fee}` |
| `my_order_terms` | customer | – | `{min_order_value, delivery_fee_below_mov, credit_days, needs_po_reference, sector_name, sector_code, sector_active, delivers, credit_limit, credit_available, outstanding, overdue, credit_blocked_reason, customer_edit_window_minutes}` (014/015/017) |
| `update_my_delivery_area` | customer | `p_city_id`, `p_pincode` | `{delivers}` — warehouse re-assigned from the pin code |
| `set_order_status` | orders:edit (in scope), customer (cancel own), driver (assigned) | `p_order_id uuid`, `p_new order_status`, `p_note text` | – |
| `assign_delivery` | orders:edit (in scope) | `p_order_id`, `p_delivery_user uuid` | – |
| `set_customer_status` | customers:approve (in scope) | `p_restaurant_id`, `p_status` (approved/suspended/pending) | – (refuses `approved` when the customer has no warehouse) |
| `admin_list_users` | team:view | – | rows: id, email, role, team_role, city_id, warehouse_id, full_name, phone, is_active, restaurant_name, restaurant_status, created_at |
| `admin_set_team_member` | team:edit (super admin to grant/remove super_admin) | `p_user`, `p_role`, `p_active`, `p_team_role`, `p_city_id`, `p_warehouse_id` | – |
| `admin_set_user_role` | team:edit | `p_user`, `p_role`, `p_active` | – (older, role-only version) |
| `check_pincode` | anyone, even logged out | `p_pincode` | `{delivers, city, city_id, area}` |
| `has_permission` | any signed-in | `p_module`, `p_action` | boolean |
| `in_my_scope` | any signed-in | `p_city`, `p_warehouse` | boolean |
| `update_my_profile` | any | `p_full_name`, `p_phone` | – |
| `update_my_restaurant` | restaurant | `p_name`, `p_address`, `p_phone`, `p_gstin` | – |
| `admin_dashboard_stats` | dashboard:view | – | `{orders_today, revenue_today, revenue_7d, pending_restaurants, open_orders_by_status, top_products_30d}` — limited to the caller's scope |
| `receive_stock` | inventory:edit (warehouse in scope) | `p_items jsonb` `[{product_id, quantity, unit_cost}]`, `p_supplier_id`, `p_note`, `p_warehouse_id` | – (older; kept for compatibility — the app now calls `receive_goods`) |
| `adjust_stock` | inventory:edit (warehouse in scope) | `p_product_id`, `p_new_qty`, `p_reason` (adjustment/wastage/returned), `p_note`, `p_warehouse_id` | – (sets that warehouse's exact count) |
| `set_order_payment` | — | — | retired by migration 015 (kept as `set_order_payment_legacy`, no grant): a paid flag without a receipt. Use `record_payment`. |
| `admin_outstanding_balances` | customers:view or payments:view | – | rows: restaurant_id, outstanding (open items minus credit on account), unpaid_orders (= open items), in scope |
| `launch_status` | settings:view | – | `{pricing_mode, stock_mode, products_listed, products_in_stock, sectors: [{code, name, is_active, can_self_register, customers, customers_approved, customers_pending, orders_30d}]}` (014) |
| `admin_customer_logins` | customers:view | – | rows per customer in scope: restaurant_id, owner_id, email, email_confirmed, confirmation_sent_at, last_sign_in_at, user_created_at (016) |
| `record_payment` | payments:edit (customer in scope) | `p_restaurant_id`, `p_amount`, `p_method` (cash/upi/bank_transfer/cheque/online/other), `p_reference`, `p_received_on date`, `p_note`, `p_allocations jsonb` `[{order_id\|debit_note_id, amount}]` (null = oldest due first) | `{id, receipt_number, amount, unallocated}` — UPI / bank / cheque need a reference |
| `allocate_payment` | payments:edit | `p_payment_id`, `p_allocations` | `{id, receipt_number, unallocated}` — apply an unapplied receipt by hand (also to a cash-on-delivery invoice) |
| `void_payment` | payments:approve | `p_payment_id`, `p_reason` | – (receipt marked void, its invoices reopen; nothing deleted) |
| `raise_debit_note` | payments:edit | `p_restaurant_id`, `p_amount`, `p_reason`, `p_order_id`, `p_due_date` | `{id, debit_note_number}` |
| `record_online_payment` | **service_role only** (the Razorpay webhook) | `p_restaurant_id`, `p_amount`, `p_gateway`, `p_gateway_ref`, `p_received_on`, `p_note` | `{id, receipt_number, duplicate}` — a repeated gateway_ref is ignored |
| `customer_receivables` | the customer (own) or payments/customers:view in scope | `p_restaurant_id` | `{outstanding, overdue, open_items[], unapplied[], unapplied_credit, exposure, pending_credit_orders, credit_limit, credit_available, oldest_due}` |
| `receivables_summary` | payments:view | – | rows of jsonb per customer in scope: `outstanding, open_items, current_due, d1_30, d31_60, d61_90, d90_plus, overdue, oldest_due, unapplied_credit, credit_limit, credit_days` |
| `customer_statement` | the customer (own) or payments:view in scope | `p_restaurant_id`, `p_from`, `p_to` | `{opening_balance, lines: [{date, kind, number, description, debit, credit, balance}], closing_balance, …}` |
| `claim_first_admin` | any signed-in user | – | `true` if the caller became the first admin; `false` once any admin exists |
| `price_board` | pricing:view | `p_category_id` (null = all) | rows of jsonb: every input of the formula (merged rule, costs, benchmark) + `cost_basis, landed_cost, suggested_price, capped, margin_amount, margin_pct, markup_effective_pct, flags` per active product |
| `compute_price` | pricing:view | `p_product_id`, `p_on date` | the same object for one product |
| `compute_price_from` | anyone (pure arithmetic) | `i jsonb` (the inputs) | the computed part only — mirrored by `computePrice()` in `web/js/core/pricing.js` |
| `apply_prices` | pricing:approve | `p_items jsonb` `[{product_id, price?}]`, `p_reason`, `p_effective_at timestamptz` (future = schedule), `p_force` (publish past a warning) | `{applied, scheduled}` — refuses below cost / under minimum markup per the rule's `guard_mode` |
| `publish_due_prices` | staff (and pg_cron) | – | number of scheduled prices applied |
| `cancel_scheduled_price` | pricing:approve | `p_id` | – |
| `my_price_list` | customer | – | `[{product_id, price}]` for every product whose price for this customer differs from the published one (their city / sector price list) |
| `set_packed_quantities` | orders:edit (in scope), order confirmed or packed | `p_order_id`, `p_items jsonb` `[{order_item_id, packed_quantity}]` | `{lines, subtotal, total_amount}` — weighed lines within tolerance, others only short; stock corrected; order re-totalled |
| `buying_list` | procurement:view (warehouse in scope) | `p_warehouse_id`, `p_delivery_date date`, `p_cover_days numeric` (default 1) | rows of jsonb per active product: `demand_qty, demand_orders, free_stock, low_stock_threshold, open_po_qty, suggested_qty, supplier_id, supplier_name, rate, moq, lead_days, latest_cost, avg_cost_30d` — mirrored by `suggestedBuy()` in `web/js/core/procurement.js` |
| `create_purchase_order` | procurement:edit (warehouse in scope) | `p_supplier_id`, `p_warehouse_id`, `p_expected_date`, `p_notes`, `p_items jsonb` `[{product_id, quantity, unit_cost?}]` (no cost = rate card) | `{id, po_number}` — a draft |
| `update_purchase_order` | procurement:edit | `p_po_id`, `p_expected_date`, `p_notes`, `p_items` | – (draft only; replaces the lines) |
| `set_purchase_order_status` | `sent`: procurement:approve · `closed` / `cancelled`: procurement:edit | `p_po_id`, `p_status` | – (cancel refused once anything is received) |
| `receive_goods` | inventory:edit (warehouse in scope) | `p_warehouse_id`, `p_supplier_id`, `p_po_id`, `p_source` (po / mandi / direct), `p_items jsonb` `[{product_id, qty_accepted, qty_rejected, unit_cost?, grade?, reject_reason?, photo_path?}]`, `p_note`, `p_bill_photo_path`, `p_bill_amount`, `p_paid_cash` | `{id, grn_number, po_status}` — writes the GRN, moves accepted stock (`received`, reference = GRN number), updates the PO lines and status; rejected needs a reason; mandi needs a bill amount |
| `category_path` | any signed-in | `p_id` | "Parent › Child" |

`update_my_restaurant` also takes `p_fssai`. `apply_stock_movement(warehouse, product, delta, ...)` is internal
(not callable from the API): every change to stock goes through it, updates `warehouse_stock` for that warehouse,
keeps `products.stock_qty` (the total across warehouses) in step, and leaves a row in `stock_movements`.
`default_warehouse_id()` picks the caller's own warehouse, else their city's default, else the only warehouse.

### Business rules inside `place_order`
* Since migration 009 each line also carries `hsn_code` and its landed cost is written to `order_line_costs` (staff-only).
* Since migration 010 the unit price is `customer_price()` (the customer's price list, else the published price) and `ordered_quantity` is kept beside `quantity`.
* Caller must be a customer that is `approved`, has a delivery address **and a warehouse** (set from the pin code at sign-up, or by an admin).
* Minimum order value and delivery fee come from the customer's sector (`sectors`), overridable per customer (`restaurants.min_order_value`, `delivery_fee_below_mov`). Below the minimum: the fee is added when it is > 0, otherwise the order is refused.
* Sectors with `needs_po_reference` must pass `p_po_reference`; it is stored on the order and printed on the invoice.
* Products hidden in the customer's city (`product_city_availability.is_available = false`) cannot be ordered.
* Stock is checked and reserved in the customer's warehouse (`warehouse_stock`), not the product total.
* `city_id`, `warehouse_id` and `sector_code` are snapshotted on the order.
* Rejects empty carts and more than 100 lines; merges duplicate products.
* Rejects inactive or out-of-stock products, and quantities below `min_order_qty` or above 10,000.
* Prices and GST rates come from the database, never from the client; the order snapshots name, unit, price and GST rate.
* Quantity must not exceed the warehouse stock; the row is locked while checking, and the stock is reserved (movement `order`). Cancelling returns it (`order_cancelled`). **Simple stock mode** (Settings → Launch, migration 014) skips the quantity check and the reservation; the in-stock flag still applies, and an order only ever returns what it took (`apply_stock_movement`).
* A sector switched off under Settings → Launch (`sectors.is_active = false`) cannot order (migration 014).
* **Credit rules** (migration 015, pay-later orders only): refused while an invoice is overdue when the sector has `block_credit_when_overdue`; refused when open invoices + pay-later orders on the way + this order would exceed the credit limit (customer override, else the sector's; NULL = no limit).
* Express slot = delivered today; other slots need a date from tomorrow up to 7 days ahead.
* `subtotal`, `tax_amount` (sum of line taxes, rounded per line) and `total_amount` are stored on the order.
* Everything happens in one transaction: either the whole order is created or nothing is.

### Allowed status transitions
See the diagram in [architecture.md](architecture.md#order-lifecycle).

## Tables readable from the browser (RLS applies)

`profiles` (own row; admin all) · `restaurants` (own; staff within scope) · `categories` · `products` (customers: listed in their city) ·
`orders` (own / assigned / staff within scope) · `order_items` · `order_status_history` · `company_settings` (all signed-in) ·
`suppliers` (inventory:view) · `stock_movements` and `warehouse_stock` (staff within scope) ·
`cities` and `sectors` (everyone, active rows) · `warehouses`, `service_zones`, `team_roles`, `role_permissions` (admin-app users) ·
`product_city_availability` (signed-in) · `audit_log` (audit:view) · `hsn_codes` (signed-in) ·
`pricing_rules`, `product_pricing`, `benchmark_sources`, `benchmark_prices`, `price_history`, `scheduled_prices`,
`order_line_costs`, views `v_product_cost` / `v_product_benchmark`, `price_lists`, `price_list_items` (pricing:view) ·
`supplier_products` (procurement:view) · `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items` (procurement:view or inventory:view, within scope) ·
`stock_batches` (inventory/fulfilment view) · `vehicles`, `trips`, `trip_orders`, `delivery_returns`, `driver_cash`, `cash_settlements` (fulfilment view, in scope; a driver sees their own trip and cash) · `delivery_charge_rules` (fulfilment/pricing view) ·
`slot_config` (any signed-in) · `order_issues`, `credit_notes` (the customer sees their own; staff with orders/payments/customers view) ·
`payments`, `debit_notes`, `payment_allocations` (the customer sees their own; payments:view or customers:view in scope — migration 015).
`company_settings` carries `pricing_mode` and `stock_mode` (014); `sectors` and `restaurants` carry `credit_limit`, sectors also `block_credit_when_overdue` and `customer_edit_window_minutes` (017); `orders` carry `due_date` (015).
`categories` now carry `parent_id` (two levels); `products` carry grade, origin, veg_type, shelf_life_days, storage_note,
parent_product_id / variant_label (pack sizes), sold_by_weight / weight_tolerance_pct.
Logged-out visitors (`anon`) may read `categories`, listed `products`, `cities` and `sectors`, and call `check_pincode`.

Direct writes from the browser, all gated by the permission matrix: `products`, `categories`, `product_city_availability`
(products:edit) · `suppliers` (inventory:edit) · `restaurants` non-status columns (customers:edit; status goes through
`set_customer_status`) · `company_settings`, `cities`, `warehouses`, `service_zones`, `sectors` terms incl. edit window (settings:edit) ·
`role_permissions` (super admin only) · `hsn_codes`, `pricing_rules`, `product_pricing`, `benchmark_sources`, `benchmark_prices`
(pricing:edit; `benchmark_prices.entered_by` is filled in by the database) · `price_lists`, `price_list_items` (pricing:edit) · `supplier_products` (procurement:edit). `audit_log`, `warehouse_stock`, `stock_movements`,
`orders`, `profiles`, `price_history`, `scheduled_prices`, `order_line_costs`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`,
`payments`, `debit_notes`, `payment_allocations` are never written directly.

## Pricing engine (migration 009)

The formula, the tables and the starting values are in [modules/pricing.md](modules/pricing.md). From the browser:
`listPriceBoard`, `applyPrices`, `publishDuePrices`, `listScheduledPrices`, `cancelScheduledPrice`, `listPricingRules`,
`savePricingRule`, `listProductPricing`, `saveProductPricing`, `saveSupplierQuote`, `listBenchmarkSources`,
`saveBenchmarkSource`, `listBenchmarkPrices`, `saveBenchmarkPrices` (upsert on source + product + day), `listPriceHistory`,
`listHsnCodes` — all in `web/js/core/api.js`, section "Pricing engine".

## Procurement (migration 011)

Rate cards, buying list, purchase orders and goods receipts are described in [modules/procurement.md](modules/procurement.md).
From the browser: `listSupplierProducts`, `saveSupplierProduct`, `deleteSupplierProduct`, `getBuyingList`, `listPurchaseOrders`,
`getPurchaseOrder`, `createPurchaseOrder`, `updatePurchaseOrder`, `setPurchaseOrderStatus`, `listGoodsReceipts`, `receiveGoods`,
`uploadBillPhoto`, `billPhotoUrl` — all in `web/js/core/api.js`, section "Procurement".

## Fulfilment & delivery (migration 012)

Pick list, stock batches / expiry, vehicles, trip sheets, proof of delivery, doorstep returns and driver cash
are described in [modules/fulfilment.md](modules/fulfilment.md). Key functions: `pick_list`, `expiring_batches`,
`write_off_expired`, `create_trip` / `update_trip` / `dispatch_trip` / `set_trip_status`, `complete_delivery`,
`settle_driver_cash`, `driver_cash_summary`, `delivery_fee_for`. Browser wrappers are in `web/js/core/api.js`,
section "Fulfilment & delivery".

## Orders + (migration 013)

Slot cut-offs, order editing, order-on-behalf, cancellation and issues → credit notes are described in
[modules/orders-plus.md](modules/orders-plus.md). Key functions: `slot_open`, `place_order` (v6),
`place_order_for`, `edit_order`, `cancel_order`, `report_issue`, `resolve_issue`. Wrappers are in the "Orders +"
section of `web/js/core/api.js`.

## Launch control (migration 014)

Settings → Launch: live sectors (`sectors.is_active`), pricing mode and stock mode (`company_settings`). Described in
[modules/launch-control.md](modules/launch-control.md). Browser wrappers: `getLaunchStatus`, `setSectorLive`,
`saveLaunchModes` in `web/js/core/api.js`; the "what to hide" rules are `web/js/core/launch.js`.

## Payments & credit (migration 015)

Receipts, allocation, credit limits, ageing and statements are described in [modules/payments.md](modules/payments.md).
Key functions: `record_payment`, `allocate_payment`, `void_payment`, `raise_debit_note`, `record_online_payment`,
`customer_receivables`, `receivables_summary`, `customer_statement`; internal: `customer_balance`,
`allocate_customer_credits`, `sync_order_payment_status`, the `orders_before_delivered` / `orders_after_delivered` /
`orders_paid_receipt` / `credit_notes_apply` triggers. Wrappers are in the "Payments & credit" section of `web/js/core/api.js`.

## Notifications & support (migration 018)

Outbox, templates, tickets, help centre, map pin and support channels are described in
[modules/notifications.md](modules/notifications.md). Key functions: `render_template`, `phone_for_sms`,
`queue_payment_reminders`, `claim_notifications`, `mark_notification` (the last three service-role only, called by the
`send-notifications` Edge Function), `retry_notification`, `open_ticket`, `reply_ticket`, `set_ticket`,
`update_my_location`, `delivery_pins`, `support_channels`; internal: `queue_notification` and the `orders_notify` /
`payments_notify` / `restaurants_notify_approved` triggers. Wrappers are in the "Notifications, support & help" section
of `web/js/core/api.js`; the JS twins of the SQL helpers are `web/js/core/notify.js`.

## Reports & dashboard (migration 019)

`sales_report`, `receivables_trend`, `admin_dashboard_stats(p_city_id)`, `set_customer_document`, the
`customer-documents` bucket, `content_pages` and the SEO fields are described in [modules/reports.md](modules/reports.md).
Wrappers: `getSalesReport`, `getReceivablesTrend`, `getDashboardStats(cityId)`, `uploadCustomerDocument`,
`customerDocumentUrl`, `listContentPages`, `getContentPage`, `saveContentPage`, `deleteContentPage` in `web/js/core/api.js`;
pure helpers in `web/js/core/reports.js`.

## Customer organisation (migration 020)

Outlets, members, approval before dispatch and the sector pages are described in
[modules/customer-organisation.md](modules/customer-organisation.md). Key functions: `my_restaurant_id` (v2: members too),
`my_customer_role`, `my_outlet_id`, `save_outlet`, `set_customer_user`, `my_customer_users`, `customer_users_of`,
`place_order(…, p_outlet_id)`, `place_order_for(…, p_outlet_id)`, `approve_order`, `set_order_status` (v4),
`my_order_terms` (v5), `delivery_pins` (v2); internal: `customer_needs_approval`, `restaurant_for_outlet`, the outlet ↔
account sync triggers. Wrappers in the "Customer organisation" section of `web/js/core/api.js`.

## Audit log

`audit_log` gets one row per insert / update / delete on products (price, listing, HSN and pack columns), orders, restaurants,
profiles, role_permissions, sectors, cities, warehouses, service_zones, company_settings, pricing_rules, product_pricing,
benchmark_sources, hsn_codes, categories, price_lists, price_list_items, suppliers, supplier_products, purchase_orders,
purchase_order_items, goods_receipts, vehicles, trips, delivery_charge_rules, cash_settlements, slot_config, order_issues, credit_notes,
payments, debit_notes, payment_allocations, notification_settings, support_tickets, help_articles, content_pages, outlets and customer_users, written by the
`write_audit_log()` trigger with `changed_by = auth.uid()`. For updates `changes` holds only the changed columns:
`{"price": {"old": 32, "new": 33}}`. Stock has its own ledger (`stock_movements`) and is not duplicated here.

## Edge Functions

| Function | Who | Body | Does |
|---|---|---|---|
| `invite-staff` | admin (JWT checked server-side) | `{ email, role: 'admin'\|'delivery', full_name, team_role, redirect_to }` | Sends a Supabase invite email and sets the new profile's role and team role (only a super admin may invite a super admin). Source: `supabase/functions/invite-staff/index.ts`. |
| `customer-access` | admin with customers:approve, in scope (JWT checked server-side) | `{ action: 'confirm_email'\|'resend_confirmation'\|'password_link'\|'set_password', restaurant_id, password?, redirect_to? }` | Gets a stuck customer signing in: confirms the email, resends the confirmation, returns a one-time recovery `link`, or sets a temporary password (the last three also confirm). Writes an `audit_log` row per action. Source: `supabase/functions/customer-access/index.ts`. |
| `razorpay-order` | approved customer (JWT checked) | `{ amount }` (rupees) | Creates a Razorpay order with the gateway secret and returns `{ order_id, amount, currency, key_id }` for the checkout. Needs secrets `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`. |
| `customer-users` | the account owner, or an admin with customers:edit in scope (JWT) | `{ action: 'invite', restaurant_id, email, full_name, phone?, role: 'outlet_manager'\|'approver', outlet_id?, redirect_to? }` | Invites a member to a customer account (`auth.admin.inviteUserByEmail` with member metadata; the sign-up trigger attaches them), or attaches an existing plain customer login. Audited. Source: `supabase/functions/customer-users/index.ts`. |
| `send-notifications` | the scheduler (`x-cron-secret` = `CRON_SECRET`) or an admin with settings:edit (JWT) | `{ limit?, dry_run? }` | Runs `queue_payment_reminders()`, claims up to `limit` queued rows and sends each through the provider named by `SMS_PROVIDER` (httpsms / msg91 / none) and `EMAIL_PROVIDER` (resend / brevo / none), marking each sent / failed / skipped. `dry_run` only reports the queue size and providers. Source: `supabase/functions/send-notifications/index.ts`. |
| `razorpay-webhook` | Razorpay (HMAC signature, no JWT) | Razorpay `payment.captured` event | Verifies `x-razorpay-signature` with `RAZORPAY_WEBHOOK_SECRET`, then `record_online_payment()` (idempotent on the payment id). Deploy with `--no-verify-jwt`. |

## Storage

Bucket `product-photos` (public read, 5 MB, JPEG/PNG/WebP). Only admins can upload, replace or delete.
Bucket `purchase-bills` (private, 8 MB, JPEG/PNG/WebP): photos of mandi bills and rejected goods; read with inventory:view
(the app uses signed links, `billPhotoUrl`), upload with inventory:edit.
Bucket `delivery-pod` (private, 8 MB, JPEG/PNG/WebP): proof-of-delivery photos; read with fulfilment:view (signed links, `podPhotoUrl`), uploaded by the driver app.
Bucket `customer-documents` (private, 8 MB, PDF/JPEG/PNG/WebP): FSSAI / GST documents under `<restaurant id>/`; the customer reads and writes their own folder, customers:view reads, customers:edit writes (`uploadCustomerDocument`, `customerDocumentUrl`).

## Errors

Database errors surface as `Error.message`; `api.js` maps common codes
(`23505` duplicate, `23503` in use, `42501` forbidden) to friendly text.
