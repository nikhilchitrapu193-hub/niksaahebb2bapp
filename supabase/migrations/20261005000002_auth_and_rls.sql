-- =============================================================================
-- Migration 002: Sign-up bootstrap, helper functions, Row Level Security
--
-- Security model in one paragraph:
--   Every table has RLS enabled. Policies below decide who can READ rows.
--   Browsers get NO direct write access to orders, order_items, history or
--   profiles — those are written only by the SECURITY DEFINER functions in
--   migration 003, which re-check the caller's role. Catalogue writes
--   (products, categories) and restaurant approval are allowed for admins via
--   policies. Even if someone steals the public API key, they can only do what
--   their own logged-in role allows.
-- =============================================================================

-- ---------- Helpers -----------------------------------------------------------

-- Returns the caller's role, or NULL if not logged in / deactivated.
-- SECURITY DEFINER so it can read profiles without recursing into RLS.
create function public.app_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.is_active
$$;

-- Returns the restaurant owned by the caller (NULL for admin/delivery users).
create function public.my_restaurant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
  from public.restaurants r
  join public.profiles p on p.id = r.owner_id
  where r.owner_id = (select auth.uid())
    and p.is_active
$$;

-- ---------- Sign-up trigger ---------------------------------------------------
-- Runs whenever a row appears in auth.users (self sign-up OR dashboard invite).
-- SECURITY NOTE: the role is ALWAYS 'restaurant' here. We never read a role
-- from user-supplied metadata, otherwise anyone could sign up as admin.
-- Staff (admin/delivery) are promoted afterwards by an admin.

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'restaurant_name', '')), '');
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    'restaurant',
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    left(new.raw_user_meta_data ->> 'phone', 20)
  );

  -- Only restaurant self-sign-ups carry a restaurant name.
  if v_rest_name is not null then
    insert into public.restaurants (owner_id, name, address, phone)
    values (
      new.id,
      left(v_rest_name, 120),
      left(coalesce(new.raw_user_meta_data ->> 'address', ''), 400),
      left(new.raw_user_meta_data ->> 'phone', 20)
    );
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Enable RLS everywhere --------------------------------------------

alter table public.profiles             enable row level security;
alter table public.restaurants          enable row level security;
alter table public.categories           enable row level security;
alter table public.products             enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_status_history enable row level security;

-- ---------- profiles: read own, admin reads all. No direct writes. ------------

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.app_role()) = 'admin');

-- ---------- restaurants -------------------------------------------------------
-- Owner reads own. Admin reads and updates all (approval / suspension).
-- Owner edits go through update_my_restaurant() so they can't change status.

create policy restaurants_select on public.restaurants
  for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.app_role()) = 'admin');

create policy restaurants_admin_update on public.restaurants
  for update to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- ---------- catalogue ---------------------------------------------------------
-- Any logged-in active user can browse (prices are private to customers, so
-- anonymous visitors see nothing). Only admins write.

create policy categories_select on public.categories
  for select to authenticated
  using ((select public.app_role()) is not null);

create policy categories_admin_write on public.categories
  for all to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

create policy products_select on public.products
  for select to authenticated
  using (
    (select public.app_role()) = 'admin'
    or ((select public.app_role()) is not null and is_active)
  );

create policy products_admin_write on public.products
  for all to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- ---------- orders (read-only for browsers) ----------------------------------

create policy orders_select on public.orders
  for select to authenticated
  using (
    (select public.app_role()) = 'admin'
    or restaurant_id = (select public.my_restaurant_id())
    or assigned_to = (select auth.uid())
  );

-- Items and history inherit visibility from the parent order. The subquery is
-- itself filtered by the orders policy above, so access rules live in one place.
create policy order_items_select on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

create policy order_history_select on public.order_status_history
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

-- ---------- Table privileges (defence in depth) ------------------------------
-- RLS is the main gate; these revokes remove capabilities we never want to
-- exist at all, so a future mistaken policy can't accidentally open them.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

revoke insert, update, delete, truncate on
  public.orders, public.order_items, public.order_status_history, public.profiles
  from authenticated;

revoke insert, delete, truncate on public.restaurants from authenticated;

-- Helper/trigger functions must not be callable as public RPC endpoints.
revoke execute on function public.handle_new_user()  from public, anon, authenticated;
revoke execute on function public.set_updated_at()   from public, anon, authenticated;
revoke execute on function public.app_role()         from public, anon;
revoke execute on function public.my_restaurant_id() from public, anon;
grant  execute on function public.app_role()         to authenticated;
grant  execute on function public.my_restaurant_id() to authenticated;
