-- =============================================================================
-- Migration 024: Super-admin test-data reset function
--
-- The is_super_admin() function already exists (checks role='admin' AND
-- team_role='super_admin'). Both Nikhil and Saaheb already have that team_role.
--
-- This migration adds ONE function: reset_test_data()
--
-- What it deletes (transactional / test data):
--   notifications, audit_log, ticket_messages, support_tickets,
--   payment_allocations, payments, credit_notes, debit_notes,
--   coupon_redemptions, coupons, order_issues, order_status_history,
--   order_line_costs, delivery_returns, trip_orders, driver_cash,
--   cash_settlements, order_items, orders, trips,
--   goods_receipt_items, goods_receipts, purchase_order_items,
--   purchase_orders, stock_batches, stock_movements, quotes, standing_orders
--   warehouse_stock (zeroed, not deleted)
--
-- What it keeps (config / demo data):
--   profiles, restaurants, customer_users, outlets,
--   cities, warehouses, service_zones, sectors, vehicles,
--   categories, products, hsn_codes, product_city_availability,
--   content_pages, help_articles,
--   pricing_rules, product_pricing, benchmark_sources, benchmark_prices,
--   price_history, scheduled_prices, price_lists, price_list_items,
--   delivery_charge_rules, slot_config,
--   suppliers, supplier_products,
--   company_settings, team_roles, role_permissions, notification_settings
-- =============================================================================

create or replace function public.reset_test_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted jsonb;
  v_orders  int; v_trips    int; v_payments int; v_tickets  int;
  v_po      int; v_stock    int; v_notes    int; v_notifs   int;
  v_quotes  int; v_standing int; v_coupons  int;
begin
  -- ── Guard ────────────────────────────────────────────────────────────────
  if not public.is_super_admin() then
    raise exception 'Only super admins can reset test data'
      using errcode = 'P0401';
  end if;

  -- ── Notifications & audit (no outbound FKs to transactional tables) ─────
  delete from public.notifications;
  get diagnostics v_notifs = row_count;

  delete from public.audit_log;

  -- ── Support tickets ───────────────────────────────────────────────────────
  delete from public.ticket_messages;
  delete from public.support_tickets;
  get diagnostics v_tickets = row_count;

  -- ── Payments ──────────────────────────────────────────────────────────────
  delete from public.payment_allocations;
  delete from public.payments;
  get diagnostics v_payments = row_count;

  delete from public.credit_notes;
  delete from public.debit_notes;
  get diagnostics v_notes = row_count;

  -- ── Coupons & redemptions ─────────────────────────────────────────────────
  delete from public.coupon_redemptions;
  delete from public.coupons;
  get diagnostics v_coupons = row_count;

  -- ── Quotes & standing orders ──────────────────────────────────────────────
  delete from public.quotes;
  get diagnostics v_quotes = row_count;

  delete from public.standing_orders;
  get diagnostics v_standing = row_count;

  -- ── Order sub-tables (before orders / trips) ──────────────────────────────
  delete from public.order_issues;
  delete from public.order_status_history;
  delete from public.order_line_costs;
  delete from public.delivery_returns;
  delete from public.trip_orders;
  delete from public.driver_cash;
  delete from public.cash_settlements;

  -- ── Orders & trips ────────────────────────────────────────────────────────
  delete from public.order_items;
  delete from public.orders;
  get diagnostics v_orders = row_count;

  delete from public.trips;
  get diagnostics v_trips = row_count;

  -- ── Procurement ───────────────────────────────────────────────────────────
  delete from public.goods_receipt_items;
  delete from public.goods_receipts;
  delete from public.purchase_order_items;
  delete from public.purchase_orders;
  get diagnostics v_po = row_count;

  -- ── Stock ledger (delete movements; zero running totals) ─────────────────
  delete from public.stock_batches;
  delete from public.stock_movements;
  get diagnostics v_stock = row_count;

  update public.warehouse_stock
  set
    total_quantity     = 0,
    reserved_quantity  = 0,
    available_quantity = 0
  where total_quantity != 0
     or reserved_quantity != 0
     or available_quantity != 0;

  -- ── Return a summary ──────────────────────────────────────────────────────
  return jsonb_build_object(
    'status',      'reset',
    'reset_at',    now(),
    'reset_by',    (select auth.uid()),
    'deleted', jsonb_build_object(
      'orders',          v_orders,
      'trips',           v_trips,
      'payments',        v_payments,
      'support_tickets', v_tickets,
      'purchase_orders', v_po,
      'stock_movements', v_stock,
      'credit_debit',    v_notes,
      'notifications',   v_notifs,
      'quotes',          v_quotes,
      'standing_orders', v_standing,
      'coupons',         v_coupons
    )
  );
end;
$$;

comment on function public.reset_test_data() is
  'Super-admin only. Wipes all transactional data (orders, trips, payments, stock, procurement, support, notifications) while keeping users, products, categories, pricing and configuration. Returns a JSON summary of what was deleted.';

-- Only super admins can call this function (EXECUTE on a SECURITY DEFINER
-- function defaults to PUBLIC, so we revoke and re-grant explicitly).
revoke execute on function public.reset_test_data() from public, anon, authenticated;
grant  execute on function public.reset_test_data() to authenticated;
-- The function itself checks is_super_admin() — so authenticated-but-not-super-admin
-- callers get a clean "Only super admins" error, not a permission error.
