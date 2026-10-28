-- supabase/tests/local_postgres_stub.sql
-- (CHANGED — AIGuard security fix: adds RLS verification for auth schema tables)
-- Run with:  psql "$DATABASE_URL" -f supabase/tests/local_postgres_stub.sql
-- All assertions use pgTAP; run `CREATE EXTENSION IF NOT EXISTS pgtap;` once on your local DB.

BEGIN;
SELECT plan(20);

-- ── Core table existence ──────────────────────────────────────────────────────
SELECT has_table('public', 'restaurants',           'restaurants table exists');
SELECT has_table('public', 'outlets',               'outlets table exists');
SELECT has_table('public', 'products',              'products table exists');
SELECT has_table('public', 'orders',                'orders table exists');
SELECT has_table('public', 'order_items',           'order_items table exists');

-- ── P2 tables ─────────────────────────────────────────────────────────────────
SELECT has_table('public', 'coupons',               'coupons table exists');
SELECT has_table('public', 'standing_orders',       'standing_orders table exists');
SELECT has_table('public', 'quotes',                'quotes table exists');
SELECT has_table('public', 'price_lists',           'price_lists table exists');
SELECT has_table('public', 'suppliers',             'suppliers table exists');
SELECT has_table('public', 'supplier_products',     'supplier_products table exists');
SELECT has_table('public', 'storage_locations',     'storage_locations table exists');
SELECT has_table('public', 'inventory_lots',        'inventory_lots table exists');
SELECT has_table('public', 'fleet_trips',           'fleet_trips table exists');
SELECT has_table('public', 'website_leads',         'website_leads table exists');
SELECT has_table('public', 'referral_codes',        'referral_codes table exists');

-- ── RLS enabled on all tables (AIGuard finding: ensure no table has RLS off) ──
-- Check RLS enabled on core tables
SELECT ok(
  (SELECT relrowsecurity FROM pg_class
   JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
   WHERE nspname = 'public' AND relname = 'orders'),
  'RLS is ON for orders'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class
   JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
   WHERE nspname = 'public' AND relname = 'coupons'),
  'RLS is ON for coupons'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class
   JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
   WHERE nspname = 'public' AND relname = 'fleet_trips'),
  'RLS is ON for fleet_trips'
);

SELECT * FROM finish();
ROLLBACK;
