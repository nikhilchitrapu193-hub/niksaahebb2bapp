-- =============================================================================
-- schema_snapshot.sql — prints the live schema as JSON for tests/fixtures/live-schema.json.
-- tests/schema.test.js checks every table, column, embed and function the browser
-- calls against that file, so refresh it after applying a migration:
--   1. Run this in the Supabase SQL editor (read-only; changes nothing).
--   2. Copy the single "snapshot" cell into tests/fixtures/live-schema.json.
--   3. npm test — a red line names the api.js call that no longer matches.
-- =============================================================================
select jsonb_pretty(jsonb_build_object(
  '_comment', 'Live schema snapshot for tests/schema.test.js. Regenerate with supabase/tests/schema_snapshot.sql after applying a migration.',
  'generated', to_char(now(), 'YYYY-MM-DD'),
  -- tables and views with their columns in order
  'tables', (select jsonb_object_agg(table_name, cols) from (
      select table_name, jsonb_agg(column_name order by ordinal_position) as cols
      from information_schema.columns where table_schema = 'public' group by table_name) t),
  -- "table.column>referenced_table", the links PostgREST uses for embeds
  'foreignKeys', (select jsonb_agg(fk order by fk) from (
      select format('%s.%s>%s', cl.relname, a.attname, rc.relname) as fk
      from pg_constraint co
      join pg_class cl on cl.oid = co.conrelid join pg_namespace n on n.oid = cl.relnamespace
      join pg_class rc on rc.oid = co.confrelid
      join pg_attribute a on a.attrelid = co.conrelid and a.attnum = co.conkey[1]
      where co.contype = 'f' and n.nspname = 'public') f),
  -- callable functions (not trigger functions, not *_legacy) with their argument names, one list per overload
  'functions', (select jsonb_object_agg(proname, overloads) from (
      select p.proname, jsonb_agg(to_jsonb(coalesce(p.proargnames[1:p.pronargs], '{}'::text[]))) as overloads
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.proname not like '%\_legacy'
        and p.prorettype <> 'trigger'::regtype
      group by p.proname) f)
)) as snapshot;
