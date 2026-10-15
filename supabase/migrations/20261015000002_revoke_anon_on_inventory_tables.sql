-- =============================================================================
-- Migration 007 — Take the default anon grants off the migration-004 tables.
--
-- Supabase grants every new table to anon by default. Migration 002 revoked
-- that for the tables that existed then; suppliers, stock_movements and
-- company_settings were created later (004) and kept the default grants.
-- RLS already denies anonymous rows on all three, so nothing leaked, but the
-- house rule is defence in depth: anon should hold no privilege it cannot use.
-- =============================================================================

revoke all on public.suppliers, public.stock_movements, public.company_settings from anon;
