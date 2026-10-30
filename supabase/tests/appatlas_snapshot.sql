-- =============================================================================
-- appatlas_snapshot.sql — prints what is LIVE in production as JSON for
-- appatlas/live-state.json. AppAtlas compares it with the repo so the docs say
-- "live" or "repo only" from evidence, never from memory.
--   1. Run this in the Supabase SQL editor (read-only; changes nothing).
--   2. Copy the single "snapshot" cell over the "database" key of appatlas/live-state.json.
--   3. Edge Functions are not visible to SQL: update "edge_functions" in the same file
--      from Dashboard → Edge Functions (or `supabase functions list`).
--   4. npm run atlas — the Health page shows what changed.
-- Row counts are estimates from pg_class (no table scan), good enough for "is it empty?".
-- =============================================================================
select jsonb_pretty(jsonb_build_object(
  'generated', to_char(now(), 'YYYY-MM-DD'),
  'postgres', current_setting('server_version'),
  -- every migration the live database has recorded, in order
  'migrations', (select jsonb_agg(jsonb_build_object('version', version, 'name', name) order by version)
                 from supabase_migrations.schema_migrations),
  -- tables: RLS switch and estimated rows
  'tables', (select jsonb_object_agg(c.relname, jsonb_build_object(
                 'rls', c.relrowsecurity,
                 'rows', greatest(c.reltuples, 0)::bigint))
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r'),
  -- policies per table: name, command, roles
  'policies', (select jsonb_object_agg(tablename, pols) from (
                 select tablename, jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles)
                                             order by policyname) as pols
                 from pg_policies where schemaname = 'public' group by tablename) p),
  -- functions: security definer? search_path pinned? trigger function?
  'functions', (select jsonb_object_agg(proname, info) from (
                 select p.proname, jsonb_build_object(
                     'security_definer', bool_or(p.prosecdef),
                     'search_path_set', bool_and(coalesce(array_to_string(p.proconfig, ',') like '%search_path%', false)),
                     'trigger', bool_or(p.prorettype = 'trigger'::regtype),
                     'overloads', count(*)) as info
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prokind = 'f'
                 group by p.proname) f),
  -- triggers on public tables: which function fires on which table
  'triggers', (select jsonb_agg(jsonb_build_object('table', c.relname, 'name', t.tgname, 'function', p.proname)
                                order by c.relname, t.tgname)
               from pg_trigger t join pg_class c on c.oid = t.tgrelid
               join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
               where n.nspname = 'public' and not t.tgisinternal),
  -- storage buckets and whether each is public
  'buckets', (select jsonb_agg(jsonb_build_object('id', id, 'public', public) order by id) from storage.buckets),
  -- the live permission matrix (super_admin needs no rows: it may do everything)
  'role_permissions', (select jsonb_agg(jsonb_build_object('role', team_role, 'module', module, 'action', action)
                                        order by team_role, module, action) from public.role_permissions),
  'team_roles', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'description', description)
                                  order by sort_order) from public.team_roles)
)) as snapshot;
