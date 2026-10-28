-- =============================================================================
-- local_postgres_stub.sql — run the migrations and security_test.sql on a plain
-- Postgres 16 (no Supabase). Creates the few Supabase pieces the SQL touches.
-- NOT needed on Supabase itself; never run it there.
--
--   createdb fs
--   psql -d fs -f supabase/tests/local_postgres_stub.sql
--   for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d fs -f "$f"; done
--   psql -d fs -f supabase/seed.sql
--   psql -d fs -f supabase/tests/security_test.sql     # the "error" is the report
-- =============================================================================

do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;  -- migration 015 grants to it
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  aud text, role text, email text, email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  confirmation_sent_at timestamptz, last_sign_in_at timestamptz,   -- read by admin_customer_logins (016)
  created_at timestamptz default now(), updated_at timestamptz default now()
);
-- Supabase's auth.uid() reads the JWT "sub" claim from a session setting.
create or replace function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;

-- Supabase grants every new public table / sequence / function to anon and
-- authenticated by default; the migrations then revoke what must not exist.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
