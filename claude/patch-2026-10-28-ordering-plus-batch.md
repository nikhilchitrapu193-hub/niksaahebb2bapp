# Patch 2026-10-28 — Phase 2 Full Build (P2-2 through P2-8)

## Summary
Complete Phase 2 build: 51 files across 7 feature modules plus AIGuard security fixes.

## New files (NEW)

### Migrations
| File | Contents |
|------|----------|
| `supabase/migrations/20261028000002_p2_ordering.sql` | coupons, standing_orders, quotes; coupon_check(), run_standing_orders(), accept_quote() |
| `supabase/migrations/20261028000003_p2_contract_pricing.sql` | price_lists, price_list_items; customer_price(), get_my_price_list() |
| `supabase/migrations/20261028000004_p2_suppliers.sql` | suppliers, supplier_products, supplier_profiles, supplier_invites; tightens USING(true) RLS |
| `supabase/migrations/20261028000005_p2_warehouse_plus.sql` | storage_locations, inventory_lots, inventory_movements; expiring_lots view; adjust_inventory() |
| `supabase/migrations/20261028000006_p2_finance_reports.sql` | finance_summary, category_mix, my_spend_report, revenue_by_sector, revenue_by_day functions |
| `supabase/migrations/20261028000007_p2_growth.sql` | website_leads, push_subscriptions, referral_codes |
| `supabase/migrations/20261028000008_p2_fleetbase.sql` | fleet_trips, fleetbase_config; apply_fleetbase_event() |

### Edge Functions
| File | Notes |
|------|-------|
| `supabase/functions/invite-supplier/index.ts` | Validates admin caller, upserts supplier_invites, sends Resend email with invite URL |
| `supabase/functions/fleetbase-dispatch/index.ts` | Admin-only; creates Fleetbase trip, inserts fleet_trips row, sets order→dispatched |
| `supabase/functions/fleetbase-webhook/index.ts` | **AIGuard fix**: timing-safe HMAC via bit-XOR; calls apply_fleetbase_event() |

### Admin UI pages
| File | Notes |
|------|-------|
| `web/js/pages/admin/coupons.js` | Coupon CRUD with sector/restaurant scope |
| `web/js/pages/admin/quotes.js` | Quote list + accept/decline; export renderCoupons too |
| `web/js/pages/admin/suppliers.js` | Supplier list + detail + invite modal |
| `web/js/pages/admin/price-lists.js` | Price list + items + assign to sector/restaurant |
| `web/js/pages/admin/warehouse.js` | Expiry alerts, lots, locations, movements tabs |
| `web/js/pages/admin/reports.js` | Finance summary, category mix, by-sector, day-by-day |
| `web/js/pages/admin/fleetbase-trips.js` | Fleet trips list + dispatch + track |
| `web/js/pages/admin/orders.js` | (CHANGED) Orders list + sub-nav linking to Quotes/Tickets/Issues |

### Restaurant UI
| File | Notes |
|------|-------|
| `web/js/pages/restaurant/ordering-plus.js` | Standing orders + bulk upload + quotes list |

### Supplier Portal
| File | Notes |
|------|-------|
| `web/supplier/login.html` | Invite-token activation + OTP sign-in page |
| `web/supplier/index.html` | Portal shell (CSP hardened) |
| `web/js/pages/supplier/login.js` | Login handler + invite-token flow |
| `web/js/pages/supplier/main.js` | Dashboard · My Products · Purchase Orders |

### Core
| File | Notes |
|------|-------|
| `web/js/core/calculators.js` | Subtotal, tax, discount helpers |
| `web/js/core/bulk-order.js` | CSV parse + validate for bulk order upload |

### PWA (P2-7)
| File | Notes |
|------|-------|
| `web/manifest.json` | PWA manifest; theme #22863a; 192 + 512 icons; shortcuts |
| `web/sw.js` | Service worker: stale-while-revalidate shell, cache-first images, push notifications |

## Changed files (CHANGED)

| File | What changed |
|------|--------------|
| `web/js/core/config.js` | P2 constants: COUPON_MIN_ORDER, QUOTE_EXPIRY_DAYS, FLEETBASE_BASE_URL |
| `web/js/core/api.js` | All P2-2 through P2-8 API functions added |
| `web/js/pages/admin/main.js` | Warehouse route (#warehouse-plus), all P2 imports + routes |
| `web/js/pages/admin/settings.js` | Coupons tab added |
| `web/js/pages/restaurant/main.js` | Coupon apply UI, Orders Plus route, coupon state |
| `web/restaurant/index.html` | CSP meta, PWA manifest link, SW registration |
| `web/admin/index.html` | CSP meta tag |
| `web/delivery/index.html` | CSP meta tag |
| `web/supplier/index.html` | CSP meta tag |
| `supabase/functions/send-notifications/index.ts` | Calls run_standing_orders() + confirmed-order emails |
| `supabase/tests/local_postgres_stub.sql` | AIGuard: RLS-on assertions for all P2 tables |

## AIGuard security findings applied

| Grade | Finding | Fix applied |
|-------|---------|-------------|
| F | Missing Content-Security-Policy | CSP meta tag on all 4 index.html files |
| F | HMAC comparison not timing-safe | `timingSafeEqual()` via bit-XOR in fleetbase-webhook |
| C | `USING (true)` policies too permissive | Tightened to `auth.role() = 'authenticated'` in migration 000004 via ALTER POLICY (no DROP) |

## Deploy instructions

```bash
# 1. Copy files to C:\Projects\fresh-supply (overwrite)
# 2. Apply migrations (run in order, already idempotent):
supabase db push --project-ref bzxygscjhvcwahwqgqin

# 3. Deploy edge functions:
supabase functions deploy send-notifications    --project-ref bzxygscjhvcwahwqgqin
supabase functions deploy invite-supplier       --project-ref bzxygscjhvcwahwqgqin
supabase functions deploy fleetbase-dispatch    --project-ref bzxygscjhvcwahwqgqin
supabase functions deploy fleetbase-webhook     --project-ref bzxygscjhvcwahwqgqin

# 4. Set secrets:
supabase secrets set FLEETBASE_API_KEY=<key>   --project-ref bzxygscjhvcwahwqgqin
supabase secrets set FLEETBASE_WEBHOOK_SECRET=<secret> --project-ref bzxygscjhvcwahwqgqin
```
