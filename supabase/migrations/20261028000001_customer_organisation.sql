-- =============================================================================
-- Migration 020: Customer organisation (Phase 2, batch P2-1).
--
--   * OUTLETS. A customer account (restaurants row = the business, its terms,
--     its credit line, its balance) can have several delivery points. Each
--     outlet has its own name, address, pin code, city, warehouse, phone, map
--     pin and preferred slot. Every existing account gets one "primary" outlet
--     copied from its address; the primary outlet and the account's own
--     address columns stay in sync by trigger, so every older screen keeps
--     working. An order carries outlet_id and the outlet's warehouse / city.
--   * CUSTOMER-SIDE USERS. Besides the owner (restaurants.owner_id) an account
--     can have members: outlet_manager (orders for their outlet, or all) and
--     approver (signs off orders, can order). Invited by the owner through the
--     customer-users Edge Function; handle_new_user() attaches the invitee to
--     the account instead of creating a new one. my_restaurant_id() now
--     resolves members too, so every policy and function that keys on it
--     covers them unchanged.
--   * APPROVAL BEFORE DISPATCH. When the sector (or the account) needs order
--     approval and an outlet manager places the order, it is 'pending' until an
--     owner / approver approves it; the kitchen sees it but cannot confirm it.
--     Rejecting cancels it (stock goes back). Orders placed by an owner,
--     approver or staff member are not held.
--   * SECTOR HOME PAGES. One content page per sector (slug sector-<code>),
--     linked from a "Who we serve" strip on the home page, with a register
--     link that pre-selects the sector.
--
-- Decision record: docs/adr/0025-customer-organisation.md
-- =============================================================================

-- ---------- 1. Outlets ---------------------------------------------------------------

create table public.outlets (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  address       text not null default '',
  phone         text,
  city_id       uuid references public.cities (id),
  pincode       text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  warehouse_id  uuid references public.warehouses (id),
  lat           numeric(9,6) check (lat is null or lat between -90 and 90),
  lng           numeric(9,6) check (lng is null or lng between -180 and 180),
  default_slot  public.delivery_slot not null default 'morning',
  is_primary    boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index outlets_restaurant_idx on public.outlets (restaurant_id, is_primary desc, name);
create unique index outlets_one_primary_idx on public.outlets (restaurant_id) where is_primary;
create trigger outlets_set_updated_at before update on public.outlets for each row execute function public.set_updated_at();
comment on table public.outlets is
  'Delivery points of a customer account. The primary outlet mirrors restaurants.address / pincode / city / warehouse / lat / lng (kept in sync by trigger).';

-- Every existing account gets its primary outlet from its own address.
insert into public.outlets (restaurant_id, name, address, phone, city_id, pincode, warehouse_id, lat, lng, is_primary)
select r.id, r.name, r.address, r.phone, r.city_id, r.pincode, r.warehouse_id, r.lat, r.lng, true from public.restaurants r;

alter table public.orders add column outlet_id uuid references public.outlets (id) on delete set null;
create index orders_outlet_idx on public.orders (outlet_id);
update public.orders o set outlet_id = p.id from public.outlets p where p.restaurant_id = o.restaurant_id and p.is_primary and o.outlet_id is null;

-- Keep the primary outlet and the account's address columns identical, whichever side is edited.
-- (No loop: each side only writes when the values differ, so the second hop is a no-op.)
create function public.sync_primary_outlet_from_restaurant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.outlets
  set address = new.address, phone = new.phone, city_id = new.city_id, pincode = new.pincode, warehouse_id = new.warehouse_id, lat = new.lat, lng = new.lng
  where restaurant_id = new.id and is_primary
    and (address, phone, city_id, pincode, warehouse_id, lat, lng) is distinct from (new.address, new.phone, new.city_id, new.pincode, new.warehouse_id, new.lat, new.lng);
  if not found and not exists (select 1 from public.outlets where restaurant_id = new.id and is_primary) then
    insert into public.outlets (restaurant_id, name, address, phone, city_id, pincode, warehouse_id, lat, lng, is_primary)
    values (new.id, new.name, new.address, new.phone, new.city_id, new.pincode, new.warehouse_id, new.lat, new.lng, true);
  end if;
  return null;
end;
$$;
create trigger restaurants_sync_primary_outlet after insert or update of address, phone, city_id, pincode, warehouse_id, lat, lng on public.restaurants
  for each row execute function public.sync_primary_outlet_from_restaurant();

create function public.sync_restaurant_from_primary_outlet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.is_primary then return null; end if;
  update public.restaurants
  set address = new.address, phone = new.phone, city_id = new.city_id, pincode = new.pincode, warehouse_id = new.warehouse_id, lat = new.lat, lng = new.lng
  where id = new.restaurant_id
    and (address, phone, city_id, pincode, warehouse_id, lat, lng) is distinct from (new.address, new.phone, new.city_id, new.pincode, new.warehouse_id, new.lat, new.lng);
  return null;
end;
$$;
create trigger outlets_sync_restaurant after insert or update on public.outlets
  for each row execute function public.sync_restaurant_from_primary_outlet();

-- ---------- 2. Customer-side users -------------------------------------------------------

create table public.customer_users (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  role          text not null check (role in ('owner', 'outlet_manager', 'approver')),
  outlet_id     uuid references public.outlets (id) on delete set null,   -- null = every outlet of the account
  is_active     boolean not null default true,
  invited_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index customer_users_restaurant_idx on public.customer_users (restaurant_id);
create trigger customer_users_set_updated_at before update on public.customer_users for each row execute function public.set_updated_at();
comment on table public.customer_users is
  'People who sign in to a customer account besides the owner. owner = everything; approver = sees all outlets, approves orders, may order; outlet_manager = orders for outlet_id (or all when null).';

-- Every current owner is a member row too, so one table answers "who belongs to this account".
insert into public.customer_users (user_id, restaurant_id, role)
select r.owner_id, r.id, 'owner' from public.restaurants r
on conflict (user_id) do nothing;

alter table public.restaurants add column needs_order_approval boolean;   -- null = the sector's setting
comment on column public.restaurants.needs_order_approval is 'Override of sectors.needs_order_approval for this account (null = inherit).';
grant update (needs_order_approval) on public.restaurants to authenticated;   -- Customers → Terms (customers:edit policy applies)

-- my_restaurant_id v2: the owner's account, else the account the signed-in member belongs to.
create or replace function public.my_restaurant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.id from public.restaurants r join public.profiles p on p.id = r.owner_id
      where r.owner_id = (select auth.uid()) and p.is_active),
    (select cu.restaurant_id from public.customer_users cu join public.profiles p on p.id = cu.user_id
      where cu.user_id = (select auth.uid()) and cu.is_active and p.is_active and p.role = 'restaurant' limit 1))
$$;

-- 'owner' | 'approver' | 'outlet_manager' | null
create function public.my_customer_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.restaurants r where r.owner_id = (select auth.uid())) then 'owner'
    else (select cu.role from public.customer_users cu where cu.user_id = (select auth.uid()) and cu.is_active limit 1) end
$$;

-- The outlet an outlet manager is limited to (null = every outlet / not a member).
create function public.my_outlet_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cu.outlet_id from public.customer_users cu
  where cu.user_id = (select auth.uid()) and cu.is_active and cu.role = 'outlet_manager'
$$;
revoke execute on function public.my_customer_role() from public, anon;
revoke execute on function public.my_outlet_id()     from public, anon;
grant  execute on function public.my_customer_role() to authenticated;
grant  execute on function public.my_outlet_id()     to authenticated;

-- Owner (or staff customers:edit in scope) changes a member's role / outlet / active flag.
create function public.set_customer_user(p_user_id uuid, p_role text default null, p_outlet_id uuid default null, p_is_active boolean default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cu   public.customer_users;
  v_rest public.restaurants;
begin
  select * into v_cu from public.customer_users where user_id = p_user_id;
  if not found then raise exception 'Member not found'; end if;
  select * into v_rest from public.restaurants where id = v_cu.restaurant_id;
  if not (v_rest.owner_id = (select auth.uid())
          or ((select public.has_permission('customers', 'edit')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)))) then
    raise exception 'Only the account owner (or our team) can change members' using errcode = '42501';
  end if;
  if v_cu.role = 'owner' then raise exception 'The owner cannot be changed here'; end if;
  if p_role is not null and p_role not in ('outlet_manager', 'approver') then raise exception 'Unknown role %', p_role; end if;
  if p_outlet_id is not null and not exists (select 1 from public.outlets where id = p_outlet_id and restaurant_id = v_cu.restaurant_id) then
    raise exception 'That outlet does not belong to this account';
  end if;
  update public.customer_users
  set role = coalesce(p_role, role),
      outlet_id = case when p_role = 'approver' then null else coalesce(p_outlet_id, outlet_id) end,
      is_active = coalesce(p_is_active, is_active)
  where user_id = p_user_id;
end;
$$;
revoke execute on function public.set_customer_user(uuid, text, uuid, boolean) from public, anon;
grant  execute on function public.set_customer_user(uuid, text, uuid, boolean) to authenticated;

-- Members of my account with their names (RLS hides other accounts' members).
create function public.my_customer_users()
returns table (user_id uuid, full_name text, phone text, role text, outlet_id uuid, outlet_name text, is_active boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select cu.user_id, p.full_name, p.phone, cu.role, cu.outlet_id, o.name, cu.is_active, cu.created_at
  from public.customer_users cu
  join public.profiles p on p.id = cu.user_id
  left join public.outlets o on o.id = cu.outlet_id
  where cu.restaurant_id = (select public.my_restaurant_id())
     or ((select public.has_permission('customers', 'view'))
         and exists (select 1 from public.restaurants r where r.id = cu.restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id))))
  order by (cu.role = 'owner') desc, p.full_name
$$;
revoke execute on function public.my_customer_users() from public, anon;
grant  execute on function public.my_customer_users() to authenticated;

-- Staff: members of one account (customers:view, in scope).
create function public.customer_users_of(p_restaurant_id uuid)
returns table (user_id uuid, full_name text, phone text, role text, outlet_id uuid, outlet_name text, is_active boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select cu.user_id, p.full_name, p.phone, cu.role, cu.outlet_id, o.name, cu.is_active, cu.created_at
  from public.customer_users cu
  join public.profiles p on p.id = cu.user_id
  left join public.outlets o on o.id = cu.outlet_id
  where cu.restaurant_id = p_restaurant_id
    and (select public.has_permission('customers', 'view'))
    and exists (select 1 from public.restaurants r where r.id = p_restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))
  order by (cu.role = 'owner') desc, p.full_name
$$;
revoke execute on function public.customer_users_of(uuid) from public, anon;
grant  execute on function public.customer_users_of(uuid) to authenticated;

-- ---------- 3. Sign-up: an invited member joins the account -------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'restaurant_name', '')), '');
  v_pincode   text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'pincode', '')), '');
  v_city_raw  text := coalesce(new.raw_user_meta_data ->> 'city_id', '');
  v_city      uuid := case when v_city_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_city_raw::uuid end;
  v_sector    text := coalesce(new.raw_user_meta_data ->> 'sector_code', 'restaurant');
  v_lat       numeric := case when (new.raw_user_meta_data ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' then (new.raw_user_meta_data ->> 'lat')::numeric end;
  v_lng       numeric := case when (new.raw_user_meta_data ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$' then (new.raw_user_meta_data ->> 'lng')::numeric end;
  -- 020: an invited member of an existing account (set by the customer-users Edge Function).
  v_member_raw text := coalesce(new.raw_user_meta_data ->> 'customer_user_of', '');
  v_member_of  uuid := case when v_member_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_member_raw::uuid end;
  v_member_role text := coalesce(new.raw_user_meta_data ->> 'customer_role', 'outlet_manager');
  v_outlet_raw text := coalesce(new.raw_user_meta_data ->> 'customer_outlet_id', '');
  v_member_outlet uuid := case when v_outlet_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_outlet_raw::uuid end;
begin
  insert into public.profiles (id, role, full_name, phone)
  values (new.id, 'restaurant', left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120), left(new.raw_user_meta_data ->> 'phone', 20));

  if v_member_of is not null and exists (select 1 from public.restaurants where id = v_member_of) then
    if v_member_role not in ('outlet_manager', 'approver') then v_member_role := 'outlet_manager'; end if;
    if v_member_outlet is not null and not exists (select 1 from public.outlets where id = v_member_outlet and restaurant_id = v_member_of) then v_member_outlet := null; end if;
    insert into public.customer_users (user_id, restaurant_id, role, outlet_id)
    values (new.id, v_member_of, v_member_role, case when v_member_role = 'approver' then null else v_member_outlet end);
    return new;
  end if;

  if v_rest_name is not null then
    if not exists (select 1 from public.sectors where code = v_sector and can_self_register and is_active) then v_sector := 'restaurant'; end if;
    if v_city is null or not exists (select 1 from public.cities where id = v_city and is_active) then
      select id into v_city from public.cities where is_active order by sort_order, name limit 1;
    end if;
    if v_pincode is not null and v_pincode !~ '^[1-9][0-9]{5}$' then v_pincode := null; end if;
    if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 then v_lat := null; v_lng := null; end if;

    insert into public.restaurants (owner_id, name, address, phone, gstin, fssai, sector_code, city_id, pincode, warehouse_id, lat, lng)
    values (new.id, left(v_rest_name, 120), left(coalesce(new.raw_user_meta_data ->> 'address', ''), 400), left(new.raw_user_meta_data ->> 'phone', 20),
            left(new.raw_user_meta_data ->> 'gstin', 20), left(new.raw_user_meta_data ->> 'fssai', 20), v_sector, v_city, v_pincode,
            public.warehouse_for_pincode(v_pincode), v_lat, v_lng);
    -- The owner's member row (the primary outlet is created by the restaurants trigger).
    insert into public.customer_users (user_id, restaurant_id, role) values (new.id, (select id from public.restaurants where owner_id = new.id), 'owner')
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

-- ---------- 4. Outlet management --------------------------------------------------------

-- Owner (or staff customers:edit in scope) adds / edits an outlet. Returns the outlet id.
-- The warehouse follows the pin code unless staff pass one explicitly.
create function public.save_outlet(
  p_id            uuid,
  p_restaurant_id uuid,
  p_name          text,
  p_address       text,
  p_phone         text default null,
  p_city_id       uuid default null,
  p_pincode       text default null,
  p_lat           numeric default null,
  p_lng           numeric default null,
  p_default_slot  public.delivery_slot default 'morning',
  p_is_active     boolean default true,
  p_warehouse_id  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid   uuid := coalesce(p_restaurant_id, (select public.my_restaurant_id()));
  v_rest  public.restaurants;
  v_staff boolean := false;
  v_pin   text := nullif(trim(coalesce(p_pincode, '')), '');
  v_wh    uuid;
  v_id    uuid := p_id;
begin
  select * into v_rest from public.restaurants where id = v_rid;
  if not found then raise exception 'Customer not found'; end if;
  if v_rest.owner_id = (select auth.uid()) then
    v_staff := false;
  elsif (select public.has_permission('customers', 'edit')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    v_staff := true;
  else
    raise exception 'Only the account owner (or our team) can manage outlets' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Give the outlet a name'; end if;
  if length(trim(coalesce(p_address, ''))) = 0 then raise exception 'The outlet needs a delivery address'; end if;
  if v_pin is not null and v_pin !~ '^[1-9][0-9]{5}$' then raise exception 'Pin code must be 6 digits'; end if;
  if p_city_id is not null and not exists (select 1 from public.cities where id = p_city_id and is_active) then raise exception 'Choose a city we serve'; end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'Both latitude and longitude are needed'; end if;
  v_wh := case when v_staff and p_warehouse_id is not null then p_warehouse_id else public.warehouse_for_pincode(v_pin) end;

  if v_id is null then
    insert into public.outlets (restaurant_id, name, address, phone, city_id, pincode, warehouse_id, lat, lng, default_slot, is_active)
    values (v_rid, left(trim(p_name), 120), left(p_address, 400), left(p_phone, 20), coalesce(p_city_id, v_rest.city_id), v_pin, v_wh, p_lat, p_lng, p_default_slot, coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.outlets
    set name = left(trim(p_name), 120), address = left(p_address, 400), phone = left(p_phone, 20), city_id = coalesce(p_city_id, city_id),
        pincode = v_pin, warehouse_id = v_wh, lat = p_lat, lng = p_lng, default_slot = p_default_slot,
        is_active = case when is_primary then true else coalesce(p_is_active, is_active) end
    where id = v_id and restaurant_id = v_rid;
    if not found then raise exception 'Outlet not found'; end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.save_outlet(uuid, uuid, text, text, text, uuid, text, numeric, numeric, public.delivery_slot, boolean, uuid) from public, anon;
grant  execute on function public.save_outlet(uuid, uuid, text, text, text, uuid, text, numeric, numeric, public.delivery_slot, boolean, uuid) to authenticated;

-- update_my_location v2: the member's own outlet pin, or the primary outlet (owner).
create or replace function public.update_my_location(p_lat numeric, p_lng numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid uuid := (select public.my_restaurant_id());
  v_out uuid := coalesce((select public.my_outlet_id()), (select id from public.outlets where restaurant_id = v_rid and is_primary));
begin
  if (select public.app_role()) is distinct from 'restaurant' or v_rid is null then
    raise exception 'Only customer accounts can set their location' using errcode = '42501';
  end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'Both latitude and longitude are needed'; end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then raise exception 'That is not a valid location'; end if;
  update public.outlets set lat = p_lat, lng = p_lng where id = v_out;   -- the trigger mirrors a primary outlet onto restaurants
end;
$$;

-- update_my_restaurant / update_my_delivery_area v2: owner only (members manage their outlet, not the account).
create or replace function public.update_my_restaurant(p_name text, p_address text, p_phone text, p_gstin text, p_fssai text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.my_customer_role()) is distinct from 'owner' then
    raise exception 'Only the account owner can change the business details' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Restaurant name is required'; end if;
  update public.restaurants
  set name = left(trim(p_name), 120), address = left(coalesce(p_address, ''), 400), phone = left(p_phone, 20), gstin = left(p_gstin, 20), fssai = left(p_fssai, 20)
  where owner_id = (select auth.uid());
  if not found then raise exception 'No restaurant is linked to this account'; end if;
end;
$$;

create or replace function public.update_my_delivery_area(p_city_id uuid, p_pincode text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pincode text := nullif(trim(coalesce(p_pincode, '')), '');
  v_wh      uuid;
begin
  if (select public.my_customer_role()) is distinct from 'owner' then
    raise exception 'Only the account owner can change the delivery area' using errcode = '42501';
  end if;
  if not exists (select 1 from public.cities where id = p_city_id and is_active) then raise exception 'Choose a city we serve'; end if;
  if v_pincode is not null and v_pincode !~ '^[1-9][0-9]{5}$' then raise exception 'Pin code must be 6 digits'; end if;
  v_wh := public.warehouse_for_pincode(v_pincode);
  update public.restaurants set city_id = p_city_id, pincode = v_pincode, warehouse_id = v_wh where owner_id = (select auth.uid());
  if not found then raise exception 'No customer account is linked to this login'; end if;
  return jsonb_build_object('delivers', v_wh is not null);
end;
$$;

-- ---------- 5. Ordering for an outlet, with approval ---------------------------------------

alter table public.orders
  add column approval_status text not null default 'not_required' check (approval_status in ('not_required', 'pending', 'approved', 'rejected')),
  add column approved_by uuid references public.profiles (id) on delete set null,
  add column approved_at timestamptz;
create index orders_approval_idx on public.orders (restaurant_id, approval_status) where approval_status = 'pending';

-- Does this account hold orders for approval? Account override, else the sector.
create function public.customer_needs_approval(p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(r.needs_order_approval, s.needs_order_approval, false)
  from public.restaurants r join public.sectors s on s.code = r.sector_code where r.id = p_restaurant_id
$$;
revoke execute on function public.customer_needs_approval(uuid) from public, anon, authenticated;

-- Build the "restaurant as seen from this outlet" record the order core expects:
-- the account's terms with the outlet's address / city / warehouse / pin / phone.
create function public.restaurant_for_outlet(p_rest public.restaurants, p_outlet public.outlets)
returns public.restaurants
language plpgsql
immutable
set search_path = ''
as $$
begin
  p_rest.address := p_outlet.address;
  p_rest.phone := coalesce(p_outlet.phone, p_rest.phone);
  p_rest.city_id := coalesce(p_outlet.city_id, p_rest.city_id);
  p_rest.pincode := p_outlet.pincode;
  p_rest.warehouse_id := p_outlet.warehouse_id;
  p_rest.lat := p_outlet.lat; p_rest.lng := p_outlet.lng;
  return p_rest;
end;
$$;
revoke execute on function public.restaurant_for_outlet(public.restaurants, public.outlets) from public, anon, authenticated;

alter function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text) rename to place_order_v6_legacy;
revoke execute on function public.place_order_v6_legacy(jsonb, text, date, public.delivery_slot, public.payment_method, text) from public, anon, authenticated;
alter function public.place_order_for(uuid, jsonb, text, date, public.delivery_slot, public.payment_method, text) rename to place_order_for_v1_legacy;
revoke execute on function public.place_order_for_v1_legacy(uuid, jsonb, text, date, public.delivery_slot, public.payment_method, text) from public, anon, authenticated;

-- place_order v7: p_outlet_id (null = the member's outlet, else the primary). An outlet manager
-- may only order for their own outlet; the order is held for approval when the account needs it.
create function public.place_order(
  p_items          jsonb,
  p_notes          text default null,
  p_delivery_date  date default null,
  p_delivery_slot  public.delivery_slot default 'morning',
  p_payment_method public.payment_method default 'cod',
  p_po_reference   text default null,
  p_outlet_id      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_rid    uuid := (select public.my_restaurant_id());
  v_role   text := (select public.my_customer_role());
  v_scope  uuid := (select public.my_outlet_id());
  v_rest   public.restaurants;
  v_outlet public.outlets;
  v_result jsonb;
  v_hold   boolean;
begin
  if (select public.app_role()) is distinct from 'restaurant' or v_rid is null then
    raise exception 'Only customer accounts can place orders' using errcode = '42501';
  end if;
  select * into v_rest from public.restaurants where id = v_rid;
  select * into v_outlet from public.outlets
  where restaurant_id = v_rid and id = coalesce(p_outlet_id, v_scope, (select id from public.outlets where restaurant_id = v_rid and is_primary));
  if not found then raise exception 'Choose one of your outlets'; end if;
  if not v_outlet.is_active then raise exception 'That outlet is switched off'; end if;
  if v_scope is not null and v_outlet.id <> v_scope then
    raise exception 'You can only order for your own outlet' using errcode = '42501';
  end if;

  v_result := public.place_order_core(public.restaurant_for_outlet(v_rest, v_outlet), v_uid, p_items, p_notes, p_delivery_date,
                                      p_delivery_slot, p_payment_method, p_po_reference, true);
  v_hold := public.customer_needs_approval(v_rid) and v_role = 'outlet_manager';
  update public.orders
  set outlet_id = v_outlet.id,
      approval_status = case when v_hold then 'pending' else 'not_required' end
  where id = (v_result ->> 'id')::uuid;
  if v_hold then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values ((v_result ->> 'id')::uuid, 'placed', 'placed', v_uid, 'Awaiting approval by the account owner / approver');
  end if;
  return v_result || jsonb_build_object('outlet_id', v_outlet.id, 'approval_status', case when v_hold then 'pending' else 'not_required' end);
end;
$$;

-- place_order_for v2: staff pick the outlet too (null = primary). Staff orders are never held.
create function public.place_order_for(
  p_restaurant_id  uuid,
  p_items          jsonb,
  p_notes          text default null,
  p_delivery_date  date default null,
  p_delivery_slot  public.delivery_slot default 'morning',
  p_payment_method public.payment_method default 'cod',
  p_po_reference   text default null,
  p_outlet_id      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest   public.restaurants;
  v_outlet public.outlets;
  v_result jsonb;
begin
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Customer not found'; end if;
  if not ((select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id))) then
    raise exception 'You cannot place orders for this customer' using errcode = '42501';
  end if;
  select * into v_outlet from public.outlets
  where restaurant_id = p_restaurant_id and id = coalesce(p_outlet_id, (select id from public.outlets where restaurant_id = p_restaurant_id and is_primary));
  if not found then raise exception 'Choose one of the customer''s outlets'; end if;
  v_result := public.place_order_core(public.restaurant_for_outlet(v_rest, v_outlet), (select auth.uid()), p_items, p_notes, p_delivery_date,
                                      p_delivery_slot, p_payment_method, p_po_reference, false);
  update public.orders set outlet_id = v_outlet.id where id = (v_result ->> 'id')::uuid;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values ((v_result ->> 'id')::uuid, 'placed', 'placed', (select auth.uid()), 'Placed by staff on the customer''s behalf');
  return v_result || jsonb_build_object('outlet_id', v_outlet.id);
end;
$$;
revoke execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid) from public, anon;
revoke execute on function public.place_order_for(uuid, jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid) from public, anon;
grant  execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid) to authenticated;
grant  execute on function public.place_order_for(uuid, jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid) to authenticated;

-- Owner / approver approves or rejects a held order. Rejecting cancels it (stock returns).
create function public.approve_order(p_order_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_order public.orders;
  v_item  record;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.restaurant_id is distinct from (select public.my_restaurant_id()) or (select public.my_customer_role()) not in ('owner', 'approver') then
    raise exception 'Only the account owner or an approver can approve orders' using errcode = '42501';
  end if;
  if v_order.approval_status <> 'pending' then raise exception 'This order is not waiting for approval (%)', v_order.approval_status; end if;
  if v_order.status <> 'placed' then raise exception 'This order has already moved on (%)', v_order.status; end if;

  if p_approve then
    update public.orders set approval_status = 'approved', approved_by = v_uid, approved_at = now() where id = p_order_id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (p_order_id, 'placed', 'placed', v_uid, coalesce('Approved: ' || nullif(left(p_note, 280), ''), 'Approved'));
  else
    update public.orders set approval_status = 'rejected', approved_by = v_uid, approved_at = now(), status = 'cancelled' where id = p_order_id;
    for v_item in select product_id, quantity from public.order_items where order_id = p_order_id loop
      perform public.apply_stock_movement(v_order.warehouse_id, v_item.product_id, v_item.quantity, 'order_cancelled', null, p_order_id, null, v_order.order_number);
    end loop;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (p_order_id, 'placed', 'cancelled', v_uid, coalesce('Rejected: ' || nullif(left(p_note, 280), ''), 'Rejected by the approver'));
  end if;
end;
$$;
revoke execute on function public.approve_order(uuid, boolean, text) from public, anon;
grant  execute on function public.approve_order(uuid, boolean, text) to authenticated;

-- set_order_status v4: the kitchen cannot confirm an order that is still waiting for the customer's approval.
create or replace function public.set_order_status(p_order_id uuid, p_new public.order_status, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    public.user_role := (select public.app_role());
  v_uid     uuid := (select auth.uid());
  v_order   public.orders;
  v_allowed boolean := false;
  v_item    record;
begin
  if v_role is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;

  if v_role = 'admin' then
    v_allowed := (select public.has_permission('orders', 'edit'))
             and (select public.in_my_scope(v_order.city_id, v_order.warehouse_id))
             and case v_order.status
                   when 'placed'           then p_new in ('confirmed', 'cancelled')
                   when 'confirmed'        then p_new in ('packed', 'cancelled')
                   when 'packed'           then p_new in ('out_for_delivery', 'cancelled')
                   when 'out_for_delivery' then p_new in ('delivered', 'cancelled')
                   else false
                 end;
    if v_allowed and v_order.approval_status = 'pending' and p_new <> 'cancelled' then
      raise exception 'This order is waiting for the customer''s approval; it can be confirmed once they approve it.';
    end if;
  elsif v_role = 'restaurant' then
    v_allowed := v_order.restaurant_id = (select public.my_restaurant_id()) and v_order.status = 'placed' and p_new = 'cancelled';
  elsif v_role = 'delivery' then
    v_allowed := v_order.assigned_to = v_uid
                 and ((v_order.status = 'packed' and p_new = 'out_for_delivery') or (v_order.status = 'out_for_delivery' and p_new = 'delivered'));
  end if;
  if not v_allowed then
    raise exception 'You cannot move this order from % to %', v_order.status, p_new using errcode = '42501';
  end if;
  if p_new = 'out_for_delivery' and v_order.assigned_to is null then
    raise exception 'Assign a delivery person before dispatching this order';
  end if;

  update public.orders set status = p_new where id = p_order_id;
  if p_new = 'cancelled' then
    for v_item in select product_id, quantity from public.order_items where order_id = p_order_id loop
      perform public.apply_stock_movement(v_order.warehouse_id, v_item.product_id, v_item.quantity, 'order_cancelled', null, p_order_id, null, v_order.order_number);
    end loop;
  end if;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, p_new, v_uid, left(p_note, 300));
end;
$$;

-- The pick list must not pack a held order either (fulfilment builds trips from confirmed orders, which
-- set_order_status already guards). Nothing else to change there.

-- delivery_pins v2: the outlet's pin (falls back to the account's).
create or replace function public.delivery_pins()
returns table (order_id uuid, lat numeric, lng numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, coalesce(p.lat, r.lat), coalesce(p.lng, r.lng)
  from public.orders o
  join public.restaurants r on r.id = o.restaurant_id
  left join public.outlets p on p.id = o.outlet_id
  where o.assigned_to = (select auth.uid())
    and o.status in ('confirmed', 'packed', 'out_for_delivery')
    and coalesce(p.lat, r.lat) is not null and coalesce(p.lng, r.lng) is not null;
$$;

-- my_order_terms v5: who I am in the account, my outlets, whether orders are held.
create or replace function public.my_order_terms()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rest  public.restaurants;
  v_sec   public.sectors;
  v_bal   jsonb;
  v_limit numeric;
  v_block text;
  v_role  text := (select public.my_customer_role());
  v_scope uuid := (select public.my_outlet_id());
begin
  select * into v_rest from public.restaurants where id = (select public.my_restaurant_id());
  if not found then return null; end if;
  select * into v_sec from public.sectors where code = v_rest.sector_code;
  v_bal := public.customer_balance(v_rest.id);
  v_limit := public.customer_credit_limit(v_rest.id);
  if v_sec.block_credit_when_overdue and (v_bal ->> 'overdue')::numeric > 0 then
    v_block := 'You have overdue invoices of ₹' || to_char((v_bal ->> 'overdue')::numeric, 'FM999999990.00') || '. Settle them to order on credit again.';
  elsif v_limit is not null and (v_bal ->> 'exposure')::numeric >= v_limit then
    v_block := 'Your credit limit of ₹' || to_char(v_limit, 'FM999999990.00') || ' is used up. Pay down your balance or choose cash on delivery.';
  end if;
  return jsonb_build_object(
    'min_order_value',              coalesce(v_rest.min_order_value, v_sec.min_order_value, 0),
    'delivery_fee_below_mov',       coalesce(v_rest.delivery_fee_below_mov, v_sec.delivery_fee_below_mov, 0),
    'credit_days',                  coalesce(v_rest.credit_days, v_sec.credit_days, 0),
    'needs_po_reference',           v_sec.needs_po_reference,
    'sector_name',                  v_sec.name,
    'sector_code',                  v_sec.code,
    'sector_active',                v_sec.is_active,
    'delivers',                     v_rest.warehouse_id is not null,
    'credit_limit',                 v_limit,
    'credit_available',             case when v_limit is null then null else greatest(v_limit - (v_bal ->> 'exposure')::numeric, 0) end,
    'outstanding',                  (v_bal ->> 'outstanding')::numeric,
    'overdue',                      (v_bal ->> 'overdue')::numeric,
    'credit_blocked_reason',        v_block,
    'customer_edit_window_minutes', coalesce(v_sec.customer_edit_window_minutes, 15),
    -- 020
    'customer_role',                v_role,
    'outlet_scope',                 v_scope,
    'needs_order_approval',         public.customer_needs_approval(v_rest.id),
    'orders_held_for_me',           public.customer_needs_approval(v_rest.id) and v_role = 'outlet_manager',
    'can_approve',                  v_role in ('owner', 'approver'),
    'pending_approvals',            (select count(*) from public.orders o where o.restaurant_id = v_rest.id and o.approval_status = 'pending' and o.status = 'placed'),
    'outlets',                      (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'pincode', p.pincode, 'city_id', p.city_id,
                                                                                  'delivers', p.warehouse_id is not null, 'default_slot', p.default_slot, 'is_primary', p.is_primary,
                                                                                  'is_active', p.is_active, 'lat', p.lat, 'lng', p.lng, 'phone', p.phone)
                                                               order by p.is_primary desc, p.name), '[]'::jsonb)
                                     from public.outlets p where p.restaurant_id = v_rest.id and (v_scope is null or p.id = v_scope)));
end;
$$;

-- ---------- 6. RLS and grants ------------------------------------------------------------

alter table public.outlets        enable row level security;
alter table public.customer_users enable row level security;
revoke all on public.outlets, public.customer_users from anon;
revoke all on public.outlets, public.customer_users from authenticated;
grant select on public.outlets, public.customer_users to authenticated;

create policy outlets_select on public.outlets for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id))));
create policy customer_users_select on public.customer_users for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or ((select public.has_permission('customers', 'view'))
             and exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))));

-- A member reads their account's row (the owner and staff already could).
alter policy restaurants_select on public.restaurants using (
  owner_id = (select auth.uid()) or id = (select public.my_restaurant_id()) or (select public.in_my_scope(city_id, warehouse_id))
);

-- A member sees the people of their own account by name.
alter policy profiles_select on public.profiles using (
  id = (select auth.uid()) or (select public.app_role()) = 'admin'
  or exists (select 1 from public.customer_users cu where cu.user_id = profiles.id and cu.restaurant_id = (select public.my_restaurant_id())));

-- An outlet manager sees their outlet's orders only; owners and approvers see every outlet's.
alter policy orders_select on public.orders using (
  (select public.in_my_scope(city_id, warehouse_id))
  or (restaurant_id = (select public.my_restaurant_id()) and ((select public.my_outlet_id()) is null or outlet_id = (select public.my_outlet_id())))
  or assigned_to = (select auth.uid())
);

create trigger audit_outlets        after insert or update or delete on public.outlets        for each row execute function public.write_audit_log();
create trigger audit_customer_users after insert or update or delete on public.customer_users for each row execute function public.write_audit_log();

-- ---------- 7. Sector home pages ---------------------------------------------------------------

insert into public.content_pages (slug, title, body, show_in_footer, sort_order) values
  ('sector-restaurant', 'For restaurants, cafés and cloud kitchens',
   'Daily produce, dairy, meat, staples and packaging at wholesale rates, delivered in the slot you choose — next morning for the week''s restock, express for the mid-service emergency.\n\n## How it works for you\n\nBrowse live prices, order by evening, receive next morning. Pay cash on delivery or settle weekly on credit once approved. Every order comes with a GST invoice.\n\n## Why kitchens switch\n\nOne supplier instead of six. Weighed items packed to the gram you ordered. A credit note the same day when something is not right.', false, 110),
  ('sector-hotel', 'For hotels and banquets',
   'Consistent grades, planned volumes and one invoice for F&B purchasing — with the credit terms and documentation your accounts team expects.\n\n## What we offer\n\nContract rates for your regular lines, scheduled slots per outlet (restaurant, banquet, staff canteen), consolidated monthly statements and GST invoices per delivery.\n\n## Multiple outlets, one account\n\nEach kitchen orders for itself; purchasing approves and sees the whole picture.', false, 120),
  ('sector-institution', 'For hospitals, schools and corporate canteens',
   'Fixed menus need fixed supply. We plan volumes with you, hold rates for the month and deliver to the kitchen door on schedule.\n\n## Built for institutions\n\nPurchase-order references on every order, approval before dispatch where your process needs it, longer credit, and statements that match your month-end.\n\n## Documentation\n\nFSSAI-compliant sourcing, GST invoices, and a monthly statement your auditors can tie back to each delivery.', false, 130),
  ('sector-defence', 'For army cantonments and unit messes',
   'Indent-based supply for unit messes and cantonment canteens: a purchase order / indent number on every order, approval by the designated officer before dispatch, and delivery inside the cantonment in the agreed window.\n\n## How it works\n\nThe mess manager raises the order from the catalogue; the approving officer signs it off in the app; we deliver against the indent and invoice on the agreed credit terms.\n\n## What we need from you\n\nThe indent format you use, the officers who approve, and the gate procedure for our vehicle. Register below and our team will set the account up with you.', false, 140),
  ('sector-retail', 'For kirana stores and retail counters',
   'Fresh produce and packaged staples in retail-friendly packs, delivered daily so your shelves stay full without a trip to the mandi.\n\n## For your counter\n\nSmall minimums, early-morning slots, cash on delivery, and the same wholesale rates the restaurants get.', false, 150)
on conflict (slug) do nothing;
