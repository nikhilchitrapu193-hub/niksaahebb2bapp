-- =============================================================================
-- Migration 006 — Foundation for many cities: cities, warehouses, service
-- zones, customer sectors, team roles with a permission matrix, city scope,
-- and an audit log. (Build list, section 1 "Foundation", Phase 1.)
--
-- What changes, in plain words:
--   * Every order, stock row and customer now belongs to a city and a
--     warehouse. Stock is held per warehouse; products.stock_qty is the total.
--   * Customers have a sector (restaurant, hotel, institution, defence, retail).
--     The sector carries the trading terms: minimum order value, delivery fee
--     below it, credit days, whether a purchase-order number is required.
--   * Admin-app users have a team role (city manager, warehouse manager, ...).
--     A permission matrix (role x module x action) decides what they may do,
--     and a city / warehouse scope limits which rows they see.
--   * Every change to important tables lands in audit_log with who / when /
--     what changed.
--
-- Reading guide (sections in order): enums & tables -> backfill of existing
-- data -> helper functions -> RLS -> business functions -> grants.
-- House rules kept: never edit an applied migration; replaced functions with a
-- new signature are renamed *_legacy (tooling refuses DROP); every function is
-- SECURITY DEFINER with search_path = '' and re-checks the caller itself.
-- =============================================================================

-- ---------- 1. Cities, warehouses, service zones -----------------------------

create table public.cities (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  state_code  char(2) not null default '37',   -- GST state code; 37 = Andhra Pradesh
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
comment on table public.cities is 'One row per city we sell in. Everything operational hangs off a city.';

create table public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  city_id     uuid not null references public.cities (id) on delete restrict,
  name        text not null check (length(trim(name)) > 0),
  address     text not null default '',
  phone       text,
  is_default  boolean not null default false,  -- the warehouse new customers in this city are served from
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (city_id, name)
);
create unique index warehouses_one_default_per_city on public.warehouses (city_id) where is_default;
create trigger warehouses_set_updated_at before update on public.warehouses
  for each row execute function public.set_updated_at();

-- A service zone is one pin code served by one warehouse. Pin codes are unique
-- in India, so a pin code can belong to only one warehouse.
create table public.service_zones (
  id            uuid primary key default gen_random_uuid(),
  warehouse_id  uuid not null references public.warehouses (id) on delete cascade,
  pincode       text not null unique check (pincode ~ '^[1-9][0-9]{5}$'),
  area_name     text not null default '',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index service_zones_warehouse_idx on public.service_zones (warehouse_id);

-- ---------- 2. Sectors (customer types) and their trading terms --------------

create table public.sectors (
  code                    text primary key check (code ~ '^[a-z_]+$'),
  name                    text not null,
  description             text not null default '',
  min_order_value         numeric(12,2) not null default 0 check (min_order_value >= 0),
  delivery_fee_below_mov  numeric(12,2) not null default 0 check (delivery_fee_below_mov >= 0),
  credit_days             integer not null default 0 check (credit_days between 0 and 365),
  needs_po_reference      boolean not null default false, -- customer must give a PO / indent number
  needs_order_approval    boolean not null default false, -- Phase 2: an approver signs off before dispatch
  can_self_register       boolean not null default false, -- shown on the public sign-up form
  sort_order              integer not null default 0,
  is_active               boolean not null default true,
  updated_at              timestamptz not null default now()
);
comment on table public.sectors is
  'Customer types. Terms here are the defaults; a customer row can override MOV, fee and credit days.';
create trigger sectors_set_updated_at before update on public.sectors
  for each row execute function public.set_updated_at();

-- Rule: an order below min_order_value is charged delivery_fee_below_mov when
-- that fee is > 0, and refused when the fee is 0 (see place_order).
insert into public.sectors (code, name, description, min_order_value, delivery_fee_below_mov, credit_days, needs_po_reference, needs_order_approval, can_self_register, sort_order) values
  ('restaurant',  'Restaurants & cloud kitchens', 'Daily orders, delivery slots, cash on delivery or short credit', 2000, 99, 7,  false, false, true,  10),
  ('hotel',       'Hotels & caterers',            'Large orders and event orders booked days ahead',                5000, 0,  15, false, false, true,  20),
  ('institution', 'Hospitals, hostels & canteens', 'Standing orders, approval chain, monthly billing',               3000, 0,  30, true,  true,  false, 30),
  ('defence',     'Army cantonments & unit messes', 'Contract rates, PO on every order, officer approval, gate pass', 0,    0,  60, true,  true,  false, 40),
  ('retail',      'Small retailers & kiranas',    'Smaller packs, pay now',                                          500,  49, 0,  false, false, false, 50);

-- ---------- 3. Team roles and the permission matrix --------------------------
-- profiles.role (admin / restaurant / delivery) still decides WHICH APP a login
-- uses. team_role decides WHAT an admin-app user may do inside it.

create table public.team_roles (
  code        text primary key check (code ~ '^[a-z_]+$'),
  name        text not null,
  description text not null default '',
  sort_order  integer not null default 0
);

insert into public.team_roles (code, name, description, sort_order) values
  ('super_admin',       'Super admin',        'The owner. Can do everything and grant access.',                      10),
  ('city_manager',      'City manager',       'Runs one city: orders, customers, stock, prices, reports.',           20),
  ('warehouse_manager', 'Warehouse manager',  'Runs one warehouse: receiving, counts, wastage, packing.',            30),
  ('procurement_buyer', 'Procurement buyer',  'Buys from suppliers and mandis; records receipts and costs.',          40),
  ('pricing_manager',   'Pricing manager',    'Sets and approves selling prices.',                                    50),
  ('finance',           'Finance',            'Payments, credit, invoices, statements, GST.',                         60),
  ('sales',             'Sales / key accounts','Signs up and approves customers; manages their terms.',               70),
  ('support',           'Support agent',      'Answers customers; edits and cancels orders.',                         80),
  ('dispatcher',        'Dispatcher',         'Assigns drivers and dispatches orders.',                               90),
  ('picker',            'Picker / packer',    'Picks and packs orders in the warehouse.',                            100),
  ('driver',            'Driver',             'Uses the delivery app only.',                                         110);

-- Which modules and actions exist is fixed in code AND here (never typed into
-- screens). Keep web/js/core/config.js MODULES / ACTIONS in step with these.
create table public.role_permissions (
  team_role  text not null references public.team_roles (code) on delete cascade,
  module     text not null check (module in ('dashboard', 'orders', 'products', 'inventory', 'customers', 'payments', 'team', 'settings', 'audit', 'reports')),
  action     text not null check (action in ('view', 'edit', 'approve', 'export')),
  primary key (team_role, module, action)
);
comment on table public.role_permissions is
  'A row means "this role may do this action in this module". super_admin needs no rows: it may do everything.';

-- Starting matrix. The owner can change every tick on the Roles screen.
insert into public.role_permissions (team_role, module, action)
select v.role, m.module, a.action
from (values
  -- role,               modules                                                                    , actions
  ('city_manager',      'dashboard,orders,products,inventory,customers,payments,audit,reports',     'view,export'),
  ('city_manager',      'orders,products,inventory,customers,payments',                             'edit,approve'),
  ('warehouse_manager', 'dashboard,orders,products,inventory',                                      'view'),
  ('warehouse_manager', 'inventory,orders',                                                         'edit'),
  ('warehouse_manager', 'inventory',                                                                'export'),
  ('procurement_buyer', 'products,inventory',                                                       'view'),
  ('procurement_buyer', 'inventory',                                                                'edit,export'),
  ('pricing_manager',   'dashboard,products,reports',                                               'view,export'),
  ('pricing_manager',   'products',                                                                 'edit,approve'),
  ('finance',           'dashboard,orders,customers,payments,audit,reports',                        'view,export'),
  ('finance',           'payments',                                                                 'edit,approve'),
  ('sales',             'dashboard,orders,products,customers',                                      'view'),
  ('sales',             'customers',                                                                'edit,approve,export'),
  ('support',           'orders,customers,products',                                                'view'),
  ('support',           'orders',                                                                   'edit'),
  ('dispatcher',        'orders,inventory',                                                         'view'),
  ('dispatcher',        'orders',                                                                   'edit'),
  ('picker',            'orders',                                                                   'view,edit')
) as v(role, modules, actions)
cross join lateral unnest(string_to_array(v.modules, ',')) as m(module)
cross join lateral unnest(string_to_array(v.actions, ',')) as a(action)
on conflict do nothing;

-- Where a team member works. NULL = every city / every warehouse.
alter table public.profiles
  add column team_role    text references public.team_roles (code) on delete set null,
  add column city_id      uuid references public.cities (id) on delete set null,
  add column warehouse_id uuid references public.warehouses (id) on delete set null;
comment on column public.profiles.team_role is 'Admin-app users: what they may do (see role_permissions). NULL for customers.';
comment on column public.profiles.city_id is 'Scope. NULL = all cities. Only meaningful for admin-app users.';

-- ---------- 4. City, sector and warehouse on existing records ----------------

alter table public.restaurants
  add column sector_code            text not null default 'restaurant' references public.sectors (code),
  add column city_id                uuid references public.cities (id) on delete restrict,
  add column warehouse_id           uuid references public.warehouses (id) on delete set null,
  add column pincode                text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  -- Per-customer overrides of the sector terms. NULL = use the sector's value.
  add column min_order_value        numeric(12,2) check (min_order_value is null or min_order_value >= 0),
  add column delivery_fee_below_mov numeric(12,2) check (delivery_fee_below_mov is null or delivery_fee_below_mov >= 0),
  add column credit_days            integer check (credit_days is null or credit_days between 0 and 365);
comment on table public.restaurants is
  'A customer account of any sector (the table name predates sectors). Starts pending; admin approves before ordering.';
create index restaurants_city_idx on public.restaurants (city_id);

alter table public.orders
  add column city_id       uuid references public.cities (id) on delete restrict,
  add column warehouse_id  uuid references public.warehouses (id) on delete restrict,
  add column sector_code   text references public.sectors (code),   -- snapshot at order time
  add column po_reference  text,                                     -- customer's PO / indent number
  add column delivery_fee  numeric(12,2) not null default 0 check (delivery_fee >= 0);
create index orders_city_created_idx on public.orders (city_id, created_at desc);
create index orders_warehouse_idx on public.orders (warehouse_id);

-- Stock per warehouse. products.stock_qty stays the total across warehouses so
-- every existing screen keeps working.
create table public.warehouse_stock (
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  product_id   uuid not null references public.products (id) on delete restrict,
  qty          numeric(12,2) not null default 0 check (qty >= 0),
  updated_at   timestamptz not null default now(),
  primary key (warehouse_id, product_id)
);
create index warehouse_stock_product_idx on public.warehouse_stock (product_id);

alter table public.stock_movements
  add column warehouse_id uuid references public.warehouses (id) on delete restrict;
create index stock_movements_warehouse_idx on public.stock_movements (warehouse_id, created_at desc);

-- A product can be listed in one city and hidden in another. No row = listed.
create table public.product_city_availability (
  product_id   uuid not null references public.products (id) on delete cascade,
  city_id      uuid not null references public.cities (id) on delete cascade,
  is_available boolean not null default true,
  primary key (product_id, city_id)
);

-- ---------- 5. Backfill: the first city and its warehouse --------------------
-- Existing data was single-city. Create Visakhapatnam + one default warehouse
-- and attach every customer, order and stock figure to it.

do $$
declare
  v_city uuid;
  v_wh   uuid;
begin
  insert into public.cities (name, state_code, sort_order) values ('Visakhapatnam', '37', 10) returning id into v_city;
  insert into public.warehouses (city_id, name, is_default) values (v_city, 'Vizag main warehouse', true) returning id into v_wh;

  update public.restaurants set city_id = v_city, warehouse_id = v_wh where city_id is null;
  update public.orders set city_id = v_city, warehouse_id = v_wh, sector_code = 'restaurant' where city_id is null;
  update public.stock_movements set warehouse_id = v_wh where warehouse_id is null;

  insert into public.warehouse_stock (warehouse_id, product_id, qty)
  select v_wh, id, stock_qty from public.products;

  -- Existing staff: admins keep full power, drivers are drivers.
  update public.profiles set team_role = 'super_admin' where role = 'admin'    and team_role is null;
  update public.profiles set team_role = 'driver'      where role = 'delivery' and team_role is null;
end;
$$;

alter table public.restaurants     alter column city_id set not null;
alter table public.orders          alter column city_id set not null;
alter table public.orders          alter column warehouse_id set not null;
alter table public.stock_movements alter column warehouse_id set not null;

-- ---------- 6. Audit log ------------------------------------------------------
-- One row per insert / update / delete on the tables listed at the end of this
-- section. For updates only the changed columns are stored (old and new).

create table public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  row_id      text not null,
  action      text not null check (action in ('insert', 'update', 'delete')),
  changed_by  uuid,                        -- auth.uid(); NULL for migrations / server jobs
  changed_at  timestamptz not null default now(),
  changes     jsonb not null               -- insert/delete: the row; update: {col: {old, new}}
);
create index audit_log_table_row_idx on public.audit_log (table_name, row_id, changed_at desc);
create index audit_log_changed_at_idx on public.audit_log (changed_at desc);
create index audit_log_changed_by_idx on public.audit_log (changed_by);

create function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old     jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new     jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_changes jsonb;
  v_row     jsonb := coalesce(v_new, v_old);
  -- Most tables have an id. role_permissions and sectors do not; build a label.
  v_row_id  text := coalesce(v_row ->> 'id', v_row ->> 'code',
                             concat_ws('/', v_row ->> 'team_role', v_row ->> 'module', v_row ->> 'action'));
begin
  if tg_op = 'UPDATE' then
    -- Only the columns that actually changed; updated_at alone is not a change.
    select coalesce(jsonb_object_agg(n.key, jsonb_build_object('old', v_old -> n.key, 'new', n.value)), '{}'::jsonb)
    into v_changes
    from jsonb_each(v_new) as n
    where n.key <> 'updated_at' and v_old -> n.key is distinct from n.value;
    if v_changes = '{}'::jsonb then return new; end if;
  else
    v_changes := coalesce(v_new, v_old);
  end if;

  insert into public.audit_log (table_name, row_id, action, changed_by, changes)
  values (tg_table_name, v_row_id, lower(tg_op), (select auth.uid()), v_changes);
  return coalesce(new, old);
end;
$$;
revoke execute on function public.write_audit_log() from public, anon, authenticated;

-- Tables worth a trail: prices, orders, payments, people, permissions, settings.
-- Stock changes are not here: stock_movements already is their ledger, so the
-- products trigger lists its columns and leaves stock_qty out.
create trigger audit_products          after insert or delete or update of sku, name, price, market_price, gst_rate, unit,
                                         min_order_qty, in_stock, is_active, category_id, brand, low_stock_threshold
                                         on public.products          for each row execute function public.write_audit_log();
create trigger audit_orders            after insert or update or delete on public.orders            for each row execute function public.write_audit_log();
create trigger audit_restaurants       after insert or update or delete on public.restaurants       for each row execute function public.write_audit_log();
create trigger audit_profiles          after update                     on public.profiles          for each row execute function public.write_audit_log();
create trigger audit_role_permissions  after insert or delete           on public.role_permissions  for each row execute function public.write_audit_log();
create trigger audit_sectors           after update                     on public.sectors           for each row execute function public.write_audit_log();
create trigger audit_cities            after insert or update or delete on public.cities            for each row execute function public.write_audit_log();
create trigger audit_warehouses        after insert or update or delete on public.warehouses        for each row execute function public.write_audit_log();
create trigger audit_service_zones     after insert or update or delete on public.service_zones     for each row execute function public.write_audit_log();
create trigger audit_company_settings  after update                     on public.company_settings  for each row execute function public.write_audit_log();

-- ---------- 7. Helper functions ---------------------------------------------

-- Does the caller have this permission? super_admin always does. Customers and
-- drivers never do (they use other apps). Deactivated users never do.
create function public.has_permission(p_module text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when p.role <> 'admin'            then false
      when p.team_role = 'super_admin'  then true
      else exists (select 1 from public.role_permissions rp
                   where rp.team_role = p.team_role and rp.module = p_module and rp.action = p_action)
    end
    from public.profiles p
    where p.id = (select auth.uid()) and p.is_active
  ), false)
$$;

create function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.role = 'admin' and p.team_role = 'super_admin'
                   from public.profiles p where p.id = (select auth.uid()) and p.is_active), false)
$$;

-- Is a row in this city / warehouse inside the caller's scope?
-- A team member with city_id NULL sees every city; with warehouse_id NULL every
-- warehouse in their city. Only admin-app users have a scope at all.
create function public.in_my_scope(p_city uuid, p_warehouse uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select p.role = 'admin'
       and (p.city_id is null or p.city_id = p_city)
       and (p.warehouse_id is null or p.warehouse_id = p_warehouse)
    from public.profiles p
    where p.id = (select auth.uid()) and p.is_active
  ), false)
$$;

-- The city of the caller's customer account (NULL for staff).
create function public.my_city_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.city_id from public.restaurants r where r.owner_id = (select auth.uid())
$$;

-- Which warehouse serves a pin code (NULL when we do not deliver there yet).
create function public.warehouse_for_pincode(p_pincode text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select z.warehouse_id
  from public.service_zones z
  join public.warehouses w on w.id = z.warehouse_id and w.is_active
  where z.pincode = p_pincode and z.is_active
$$;

-- The warehouse a staff action applies to when the screen did not pick one:
-- the caller's own warehouse, else the default warehouse of their city, else
-- the only warehouse there is. Raises when it cannot decide.
create function public.default_warehouse_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_wh      uuid;
begin
  select * into v_profile from public.profiles where id = (select auth.uid());
  if v_profile.warehouse_id is not null then return v_profile.warehouse_id; end if;

  if v_profile.city_id is not null then
    select id into v_wh from public.warehouses where city_id = v_profile.city_id and is_default and is_active;
    if v_wh is not null then return v_wh; end if;
  end if;

  if (select count(*) from public.warehouses where is_active) = 1 then
    select id into v_wh from public.warehouses where is_active;
    return v_wh;
  end if;

  raise exception 'Choose a warehouse';
end;
$$;

-- Public pin-code check for the website: {"delivers": true, "city": "...", "warehouse": "..."}
create function public.check_pincode(p_pincode text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('delivers', true, 'city', c.name, 'city_id', c.id, 'area', z.area_name)
    from public.service_zones z
    join public.warehouses w on w.id = z.warehouse_id and w.is_active
    join public.cities c on c.id = w.city_id and c.is_active
    where z.pincode = p_pincode and z.is_active
  ), jsonb_build_object('delivers', false))
$$;

-- ---------- 8. Row Level Security -------------------------------------------

alter table public.cities                    enable row level security;
alter table public.warehouses                enable row level security;
alter table public.service_zones             enable row level security;
alter table public.sectors                   enable row level security;
alter table public.team_roles                enable row level security;
alter table public.role_permissions          enable row level security;
alter table public.warehouse_stock           enable row level security;
alter table public.product_city_availability enable row level security;
alter table public.audit_log                 enable row level security;

-- Supabase grants new tables to anon by default; take that away first (the
-- logged-out website may read only cities and sectors, for the sign-up form).
revoke all on public.cities, public.warehouses, public.service_zones, public.sectors, public.team_roles,
  public.role_permissions, public.warehouse_stock, public.product_city_availability, public.audit_log from anon;
revoke all on all sequences in schema public from anon;
grant select on public.cities, public.sectors to anon;
-- anon may not call app_role(), so logged-out and logged-in readers get separate policies.
create policy cities_public_select  on public.cities  for select to anon using (is_active);
create policy cities_select         on public.cities  for select to authenticated using (is_active or (select public.app_role()) = 'admin');
create policy sectors_public_select on public.sectors for select to anon using (is_active);
create policy sectors_select        on public.sectors for select to authenticated using (is_active or (select public.app_role()) = 'admin');
create policy team_roles_select     on public.team_roles for select to authenticated using (true);
create policy warehouses_select     on public.warehouses for select to authenticated using ((select public.app_role()) = 'admin');
create policy service_zones_select  on public.service_zones for select to authenticated using ((select public.app_role()) = 'admin');

-- Settings writes need settings:edit. Policies are "for all" so one line
-- covers insert / update / delete.
create policy cities_settings_write on public.cities for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));
create policy warehouses_settings_write on public.warehouses for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));
create policy service_zones_settings_write on public.service_zones for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));
create policy sectors_settings_update on public.sectors for update to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));

-- The permission matrix: every admin-app user may read it (the menu needs it);
-- only the super admin may change it, so nobody can grant themselves more.
create policy role_permissions_select on public.role_permissions for select to authenticated
  using ((select public.app_role()) = 'admin');
create policy role_permissions_super_admin_write on public.role_permissions for all to authenticated
  using ((select public.is_super_admin())) with check ((select public.is_super_admin()));

-- Stock per warehouse: read within scope; written only by stock functions.
create policy warehouse_stock_select on public.warehouse_stock for select to authenticated
  using ((select public.in_my_scope((select w.city_id from public.warehouses w where w.id = warehouse_id), warehouse_id)));
revoke insert, update, delete, truncate on public.warehouse_stock from authenticated;

create policy availability_select on public.product_city_availability for select to authenticated
  using ((select public.app_role()) is not null);
create policy availability_products_write on public.product_city_availability for all to authenticated
  using ((select public.has_permission('products', 'edit'))) with check ((select public.has_permission('products', 'edit')));

create policy audit_log_select on public.audit_log for select to authenticated
  using ((select public.has_permission('audit', 'view')));
revoke insert, update, delete, truncate on public.audit_log from authenticated;
revoke insert, update, delete, truncate on public.team_roles from authenticated;
revoke insert, delete, truncate on public.sectors from authenticated;

-- Existing policies now respect scope and the permission matrix.
-- (ALTER POLICY keeps history intact: no DROP needed.)
alter policy orders_select on public.orders using (
  (select public.in_my_scope(city_id, warehouse_id))
  or restaurant_id = (select public.my_restaurant_id())
  or assigned_to = (select auth.uid())
);

alter policy restaurants_select on public.restaurants using (
  owner_id = (select auth.uid()) or (select public.in_my_scope(city_id, warehouse_id))
);
alter policy restaurants_admin_update on public.restaurants
  using ((select public.has_permission('customers', 'edit')) and (select public.in_my_scope(city_id, warehouse_id)))
  with check ((select public.has_permission('customers', 'edit')));
-- Approval / suspension goes through set_customer_status() (customers:approve),
-- so the status column is not directly updatable from the browser.
revoke update on public.restaurants from authenticated;
grant update (sector_code, city_id, warehouse_id, pincode, min_order_value, delivery_fee_below_mov, credit_days,
              name, address, phone, gstin, fssai)
  on public.restaurants to authenticated;

alter policy products_admin_write on public.products
  using ((select public.has_permission('products', 'edit')))
  with check ((select public.has_permission('products', 'edit')));
alter policy categories_admin_write on public.categories
  using ((select public.has_permission('products', 'edit')))
  with check ((select public.has_permission('products', 'edit')));

-- Customers see only products listed in their city.
alter policy products_select on public.products using (
  (select public.app_role()) = 'admin'
  or ((select public.app_role()) is not null and is_active and not exists (
        select 1 from public.product_city_availability a
        where a.product_id = products.id and a.city_id = (select public.my_city_id()) and not a.is_available))
);

alter policy suppliers_admin_all on public.suppliers
  using ((select public.has_permission('inventory', 'view')))
  with check ((select public.has_permission('inventory', 'edit')));
alter policy stock_movements_admin_select on public.stock_movements
  using ((select public.in_my_scope((select w.city_id from public.warehouses w where w.id = warehouse_id), warehouse_id)));
alter policy company_settings_admin_update on public.company_settings
  using ((select public.has_permission('settings', 'edit')))
  with check ((select public.has_permission('settings', 'edit')));

-- ---------- 9. Sign-up records city and pin code -----------------------------

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
  -- Only cast when it looks like a uuid; a bad value must not break sign-up.
  v_city      uuid := case when v_city_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_city_raw::uuid end;
  v_sector    text := coalesce(new.raw_user_meta_data ->> 'sector_code', 'restaurant');
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    'restaurant',
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    left(new.raw_user_meta_data ->> 'phone', 20)
  );

  if v_rest_name is not null then
    -- Only sectors that may self-register are accepted from the form; anything
    -- else falls back to 'restaurant' and the admin can change it later.
    if not exists (select 1 from public.sectors where code = v_sector and can_self_register and is_active) then
      v_sector := 'restaurant';
    end if;
    -- No valid city chosen: use the first active city so the row is never orphaned.
    if v_city is null or not exists (select 1 from public.cities where id = v_city and is_active) then
      select id into v_city from public.cities where is_active order by sort_order, name limit 1;
    end if;
    if v_pincode is not null and v_pincode !~ '^[1-9][0-9]{5}$' then v_pincode := null; end if;

    insert into public.restaurants (owner_id, name, address, phone, gstin, fssai, sector_code, city_id, pincode, warehouse_id)
    values (
      new.id,
      left(v_rest_name, 120),
      left(coalesce(new.raw_user_meta_data ->> 'address', ''), 400),
      left(new.raw_user_meta_data ->> 'phone', 20),
      left(new.raw_user_meta_data ->> 'gstin', 20),
      left(new.raw_user_meta_data ->> 'fssai', 20),
      v_sector,
      v_city,
      v_pincode,
      public.warehouse_for_pincode(v_pincode)
    );
  end if;

  return new;
end;
$$;

-- Admin-app logins always get a team role, so the permission checks have
-- something to look at even when the invite function did not set one.
create function public.default_team_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role = 'admin'    and new.team_role is null then new.team_role := 'super_admin'; end if;
  if new.role = 'delivery' and new.team_role is null then new.team_role := 'driver'; end if;
  if new.role = 'restaurant' then new.team_role := null; new.city_id := null; new.warehouse_id := null; end if;
  return new;
end;
$$;
revoke execute on function public.default_team_role() from public, anon, authenticated;
create trigger profiles_default_team_role before insert or update of role, team_role on public.profiles
  for each row execute function public.default_team_role();

-- ---------- 10. Stock functions, now per warehouse ---------------------------

alter function public.apply_stock_movement(uuid, numeric, public.stock_reason, uuid, uuid, numeric, text)
  rename to apply_stock_movement_legacy;

-- Internal: one movement in one warehouse. Keeps warehouse_stock and the
-- product total in step. Not callable from the API (no grant).
create function public.apply_stock_movement(
  p_warehouse_id uuid,
  p_product_id   uuid,
  p_qty_delta    numeric,
  p_reason       public.stock_reason,
  p_supplier     uuid default null,
  p_order_id     uuid default null,
  p_unit_cost    numeric default null,
  p_note         text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new numeric;
begin
  if p_warehouse_id is null then raise exception 'Choose a warehouse'; end if;

  -- Make sure the per-warehouse row exists, then lock it and apply the change.
  insert into public.warehouse_stock (warehouse_id, product_id, qty)
  values (p_warehouse_id, p_product_id, 0)
  on conflict (warehouse_id, product_id) do nothing;

  select qty + p_qty_delta into v_new from public.warehouse_stock
  where warehouse_id = p_warehouse_id and product_id = p_product_id for update;
  if v_new < 0 then raise exception 'Stock cannot go below zero in this warehouse'; end if;

  update public.warehouse_stock set qty = v_new, updated_at = now()
  where warehouse_id = p_warehouse_id and product_id = p_product_id;

  update public.products set stock_qty = stock_qty + p_qty_delta where id = p_product_id;
  if not found then raise exception 'Product not found'; end if;

  insert into public.stock_movements
    (warehouse_id, product_id, qty_delta, reason, supplier_id, order_id, unit_cost, note, created_by)
  values
    (p_warehouse_id, p_product_id, p_qty_delta, p_reason, p_supplier, p_order_id, p_unit_cost, left(p_note, 300), (select auth.uid()));
end;
$$;
revoke execute on function public.apply_stock_movement(uuid, uuid, numeric, public.stock_reason, uuid, uuid, numeric, text)
  from public, anon, authenticated;

alter function public.receive_stock(jsonb, uuid, text) rename to receive_stock_legacy;
revoke execute on function public.receive_stock_legacy(jsonb, uuid, text) from public, anon, authenticated;

-- Goods received into one warehouse. p_items = [{product_id, quantity, unit_cost}]
-- Rule: needs inventory:edit and the warehouse must be in the caller's scope.
create function public.receive_stock(
  p_items        jsonb,
  p_supplier_id  uuid default null,
  p_note         text default null,
  p_warehouse_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wh   uuid := coalesce(p_warehouse_id, public.default_warehouse_id());
  v_line record;
begin
  if not (select public.has_permission('inventory', 'edit')) then
    raise exception 'You do not have permission to receive stock' using errcode = '42501';
  end if;
  if not (select public.in_my_scope((select city_id from public.warehouses where id = v_wh), v_wh)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one line';
  end if;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id,
           (e ->> 'quantity')::numeric as qty,
           (e ->> 'unit_cost')::numeric as unit_cost
    from jsonb_array_elements(p_items) as e
  loop
    if v_line.qty is null or v_line.qty <= 0 then
      raise exception 'Received quantity must be greater than zero';
    end if;
    perform public.apply_stock_movement(v_wh, v_line.product_id, v_line.qty, 'received',
                                        p_supplier_id, null, v_line.unit_cost, p_note);
  end loop;
end;
$$;

alter function public.adjust_stock(uuid, numeric, public.stock_reason, text) rename to adjust_stock_legacy;
revoke execute on function public.adjust_stock_legacy(uuid, numeric, public.stock_reason, text) from public, anon, authenticated;

-- Set one warehouse's stock of a product to an exact count (or write off
-- wastage / accept a return). p_reason: adjustment | wastage | returned
create function public.adjust_stock(
  p_product_id   uuid,
  p_new_qty      numeric,
  p_reason       public.stock_reason default 'adjustment',
  p_note         text default null,
  p_warehouse_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wh      uuid := coalesce(p_warehouse_id, public.default_warehouse_id());
  v_current numeric;
begin
  if not (select public.has_permission('inventory', 'edit')) then
    raise exception 'You do not have permission to adjust stock' using errcode = '42501';
  end if;
  if not (select public.in_my_scope((select city_id from public.warehouses where id = v_wh), v_wh)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;
  if p_reason not in ('adjustment', 'wastage', 'returned') then
    raise exception 'Reason must be adjustment, wastage or returned';
  end if;
  if p_new_qty is null or p_new_qty < 0 then
    raise exception 'New quantity must be zero or more';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found';
  end if;

  -- Lock the per-warehouse row (it may not exist yet: then current = 0).
  select qty into v_current from public.warehouse_stock
  where warehouse_id = v_wh and product_id = p_product_id for update;
  v_current := coalesce(v_current, 0);
  if v_current = p_new_qty then return; end if;

  perform public.apply_stock_movement(v_wh, p_product_id, p_new_qty - v_current, p_reason, null, null, null, p_note);
end;
$$;

-- ---------- 11. place_order v3: city, warehouse, sector terms ----------------
-- New rules on top of v2 (stock, slots, GST):
--   * the customer must have a warehouse (from their pin code or set by admin);
--   * minimum order value and delivery fee come from the sector, overridable
--     per customer: below MOV, charge the fee if there is one, else refuse;
--   * sectors with needs_po_reference must give a PO / indent number;
--   * stock is reserved in the customer's warehouse;
--   * city, warehouse and sector are snapshotted on the order.

alter function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method)
  rename to place_order_v2_legacy;
revoke execute on function public.place_order_v2_legacy(jsonb, text, date, public.delivery_slot, public.payment_method)
  from public, anon, authenticated;

create function public.place_order(
  p_items          jsonb,
  p_notes          text default null,
  p_delivery_date  date default null,
  p_delivery_slot  public.delivery_slot default 'morning',
  p_payment_method public.payment_method default 'cod',
  p_po_reference   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_rest      public.restaurants;
  v_sector    public.sectors;
  v_mov       numeric(12,2);
  v_fee       numeric(12,2);
  v_order_id  uuid;
  v_number    text;
  v_line      record;
  v_product   public.products;
  v_available numeric;
  v_subtotal  numeric(12,2);
  v_tax       numeric(12,2);
  v_total     numeric(12,2);
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Only customer accounts can place orders' using errcode = '42501';
  end if;

  select * into v_rest from public.restaurants where owner_id = v_uid;
  if not found then
    raise exception 'No customer account is linked to this login';
  end if;
  if v_rest.status <> 'approved' then
    raise exception 'Your account is not approved yet (status: %). Please wait for approval.', v_rest.status;
  end if;
  if length(trim(v_rest.address)) = 0 then
    raise exception 'Add a delivery address to your profile before ordering';
  end if;
  if v_rest.warehouse_id is null then
    raise exception 'We do not deliver to your area yet. Check your pin code or contact us.';
  end if;

  select * into v_sector from public.sectors where code = v_rest.sector_code;
  v_mov := coalesce(v_rest.min_order_value, v_sector.min_order_value, 0);
  v_fee := coalesce(v_rest.delivery_fee_below_mov, v_sector.delivery_fee_below_mov, 0);

  if v_sector.needs_po_reference and length(trim(coalesce(p_po_reference, ''))) = 0 then
    raise exception 'A purchase order / indent number is required for % orders', v_sector.name;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order must contain at least one item';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'An order can contain at most 100 lines';
  end if;

  -- Delivery: express = today, everything else = tomorrow or later (within 7 days).
  if p_delivery_slot = 'express' then
    p_delivery_date := v_today;
  else
    p_delivery_date := coalesce(p_delivery_date, v_today + 1);
    if p_delivery_date < v_today + 1 then
      raise exception 'Scheduled deliveries start from tomorrow. Choose Express for today.';
    end if;
    if p_delivery_date > v_today + 7 then
      raise exception 'Delivery date must be within the next 7 days';
    end if;
  end if;

  insert into public.orders (restaurant_id, placed_by, restaurant_name, delivery_address, contact_phone,
                             notes, delivery_date, delivery_slot, payment_method,
                             city_id, warehouse_id, sector_code, po_reference)
  values (v_rest.id, v_uid, v_rest.name, v_rest.address, v_rest.phone,
          left(p_notes, 500), p_delivery_date, p_delivery_slot, p_payment_method,
          v_rest.city_id, v_rest.warehouse_id, v_rest.sector_code, left(nullif(trim(p_po_reference), ''), 60))
  returning id, order_number into v_order_id, v_number;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id,
           sum((e ->> 'quantity')::numeric) as qty
    from jsonb_array_elements(p_items) as e
    group by 1
  loop
    select * into v_product
    from public.products
    where id = v_line.product_id and is_active
      and not exists (select 1 from public.product_city_availability a
                      where a.product_id = products.id and a.city_id = v_rest.city_id and not a.is_available);
    if not found then
      raise exception 'Product % is not available in your city', v_line.product_id;
    end if;
    if not v_product.in_stock then
      raise exception '"%" is out of stock today', v_product.name;
    end if;
    if v_line.qty is null or v_line.qty < v_product.min_order_qty or v_line.qty > 10000 then
      raise exception 'Quantity for "%" must be between % and 10000', v_product.name, v_product.min_order_qty;
    end if;

    -- Lock this warehouse's stock row: two customers cannot both take the last units.
    select qty into v_available from public.warehouse_stock
    where warehouse_id = v_rest.warehouse_id and product_id = v_product.id for update;
    v_available := coalesce(v_available, 0);
    if v_line.qty > v_available then
      raise exception 'Only % % of "%" available right now', v_available, v_product.unit, v_product.name;
    end if;

    insert into public.order_items (order_id, product_id, product_name, unit, unit_price, quantity, gst_rate)
    values (v_order_id, v_product.id, v_product.name, v_product.unit, v_product.price, v_line.qty, v_product.gst_rate);

    perform public.apply_stock_movement(v_rest.warehouse_id, v_product.id, -v_line.qty, 'order', null, v_order_id, null, v_number);
  end loop;

  select coalesce(sum(line_total), 0), coalesce(sum(tax_amount), 0)
  into v_subtotal, v_tax
  from public.order_items where order_id = v_order_id;

  -- Minimum order value rule (see sectors).
  if v_subtotal < v_mov then
    if v_fee <= 0 then
      raise exception 'Minimum order value is %. Add % more to place this order.', v_mov, v_mov - v_subtotal;
    end if;
  else
    v_fee := 0;
  end if;

  v_total := v_subtotal + v_tax + v_fee;
  update public.orders
  set subtotal = v_subtotal, tax_amount = v_tax, delivery_fee = v_fee, total_amount = v_total
  where id = v_order_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by)
  values (v_order_id, null, 'placed', v_uid);

  return jsonb_build_object('id', v_order_id, 'order_number', v_number, 'total_amount', v_total, 'delivery_fee', v_fee);
end;
$$;

-- What the cart should show before ordering: the customer's MOV, fee and
-- whether a PO number is needed. Read-only, customer only.
create function public.my_order_terms()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'min_order_value',        coalesce(r.min_order_value, s.min_order_value, 0),
    'delivery_fee_below_mov', coalesce(r.delivery_fee_below_mov, s.delivery_fee_below_mov, 0),
    'credit_days',            coalesce(r.credit_days, s.credit_days, 0),
    'needs_po_reference',     s.needs_po_reference,
    'sector_name',            s.name,
    'delivers',               r.warehouse_id is not null
  )
  from public.restaurants r
  join public.sectors s on s.code = r.sector_code
  where r.owner_id = (select auth.uid())
$$;

-- ---------- 12. set_order_status: permission matrix + per-warehouse restock --

create or replace function public.set_order_status(
  p_order_id uuid,
  p_new      public.order_status,
  p_note     text default null
)
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
  if v_role is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found';
  end if;

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
  elsif v_role = 'restaurant' then
    v_allowed := v_order.restaurant_id = (select public.my_restaurant_id())
                 and v_order.status = 'placed'
                 and p_new = 'cancelled';
  elsif v_role = 'delivery' then
    v_allowed := v_order.assigned_to = v_uid
                 and ((v_order.status = 'packed' and p_new = 'out_for_delivery')
                   or (v_order.status = 'out_for_delivery' and p_new = 'delivered'));
  end if;

  if not v_allowed then
    raise exception 'You cannot move this order from % to %', v_order.status, p_new
      using errcode = '42501';
  end if;

  if p_new = 'out_for_delivery' and v_order.assigned_to is null then
    raise exception 'Assign a delivery person before dispatching this order';
  end if;

  update public.orders set status = p_new where id = p_order_id;

  -- Cancelled orders give their stock back to the warehouse they came from.
  if p_new = 'cancelled' then
    for v_item in select product_id, quantity from public.order_items where order_id = p_order_id loop
      perform public.apply_stock_movement(v_order.warehouse_id, v_item.product_id, v_item.quantity, 'order_cancelled',
                                          null, p_order_id, null, v_order.order_number);
    end loop;
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, p_new, v_uid, left(p_note, 300));
end;
$$;

create or replace function public.assign_delivery(p_order_id uuid, p_delivery_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if not (select public.has_permission('orders', 'edit')) then
    raise exception 'You do not have permission to assign drivers' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if not (select public.in_my_scope(v_order.city_id, v_order.warehouse_id)) then
    raise exception 'This order is outside your scope' using errcode = '42501';
  end if;
  if v_order.status in ('delivered', 'cancelled') then
    raise exception 'This order is already %', v_order.status;
  end if;

  if p_delivery_user is not null and not exists (
    select 1 from public.profiles
    where id = p_delivery_user and role = 'delivery' and is_active
  ) then
    raise exception 'That user is not an active delivery account';
  end if;

  update public.orders set assigned_to = p_delivery_user where id = p_order_id;
end;
$$;

create or replace function public.set_order_payment(p_order_id uuid, p_status public.payment_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if not (select public.has_permission('payments', 'edit')) then
    raise exception 'You do not have permission to record payments' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if not (select public.in_my_scope(v_order.city_id, v_order.warehouse_id)) then
    raise exception 'This order is outside your scope' using errcode = '42501';
  end if;

  update public.orders
  set payment_status = p_status,
      paid_at = case when p_status = 'paid' then now() else null end
  where id = p_order_id;
end;
$$;

-- ---------- 13. Customers: approval and terms --------------------------------

-- Approve, suspend or reinstate a customer. Needs customers:approve.
create function public.set_customer_status(p_restaurant_id uuid, p_status public.restaurant_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest public.restaurants;
begin
  if not (select public.has_permission('customers', 'approve')) then
    raise exception 'You do not have permission to approve customers' using errcode = '42501';
  end if;
  select * into v_rest from public.restaurants where id = p_restaurant_id for update;
  if not found then raise exception 'Customer not found'; end if;
  if not (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    raise exception 'This customer is outside your scope' using errcode = '42501';
  end if;
  -- Approving without a warehouse would let them order into nowhere.
  if p_status = 'approved' and v_rest.warehouse_id is null then
    raise exception 'Set a delivery warehouse (or a served pin code) before approving';
  end if;
  update public.restaurants set status = p_status where id = p_restaurant_id;
end;
$$;

-- Customers update their own delivery area. The warehouse follows the pin
-- code when we serve it; otherwise it is cleared and the admin must set one.
create function public.update_my_delivery_area(p_city_id uuid, p_pincode text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pincode text := nullif(trim(coalesce(p_pincode, '')), '');
  v_wh      uuid;
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Customer accounts only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.cities where id = p_city_id and is_active) then
    raise exception 'Choose a city we serve';
  end if;
  if v_pincode is not null and v_pincode !~ '^[1-9][0-9]{5}$' then
    raise exception 'Pin code must be 6 digits';
  end if;

  v_wh := public.warehouse_for_pincode(v_pincode);
  update public.restaurants
  set city_id = p_city_id, pincode = v_pincode, warehouse_id = v_wh
  where owner_id = (select auth.uid());
  if not found then raise exception 'No customer account is linked to this login'; end if;

  return jsonb_build_object('delivers', v_wh is not null);
end;
$$;

-- ---------- 14. Team: list and edit members with role and scope --------------

alter function public.admin_list_users() rename to admin_list_users_legacy;
revoke execute on function public.admin_list_users_legacy() from public, anon, authenticated;

create function public.admin_list_users()
returns table (
  id                uuid,
  email             text,
  role              public.user_role,
  team_role         text,
  city_id           uuid,
  warehouse_id      uuid,
  full_name         text,
  phone             text,
  is_active         boolean,
  restaurant_name   text,
  restaurant_status public.restaurant_status,
  created_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('team', 'view')) then
    raise exception 'You do not have permission to see the team' using errcode = '42501';
  end if;

  return query
  select p.id, u.email::text, p.role, p.team_role, p.city_id, p.warehouse_id, p.full_name, p.phone, p.is_active,
         r.name, r.status, p.created_at
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.restaurants r on r.owner_id = p.id
  order by p.created_at desc;
end;
$$;

-- Set a member's app role, team role, scope and active flag in one call.
-- Rules: team:edit; you cannot edit yourself; only a super admin may make or
-- unmake another super admin (so access cannot be escalated sideways).
create function public.admin_set_team_member(
  p_user         uuid,
  p_role         public.user_role,
  p_active       boolean,
  p_team_role    text default null,
  p_city_id      uuid default null,
  p_warehouse_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.profiles;
begin
  if not (select public.has_permission('team', 'edit')) then
    raise exception 'You do not have permission to edit the team' using errcode = '42501';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'You cannot change your own role or status';
  end if;
  select * into v_current from public.profiles where id = p_user for update;
  if not found then raise exception 'User not found'; end if;

  if (p_team_role = 'super_admin' or v_current.team_role = 'super_admin') and not (select public.is_super_admin()) then
    raise exception 'Only a super admin can grant or remove super admin' using errcode = '42501';
  end if;
  -- Staff always need a team role; a missing one would silently become super_admin (default_team_role trigger).
  if p_role <> 'restaurant' and p_team_role is null then
    raise exception 'Choose a team role';
  end if;
  if p_team_role is not null and not exists (select 1 from public.team_roles where code = p_team_role) then
    raise exception 'Unknown team role %', p_team_role;
  end if;
  if p_warehouse_id is not null and p_city_id is not null
     and not exists (select 1 from public.warehouses where id = p_warehouse_id and city_id = p_city_id) then
    raise exception 'That warehouse is not in the chosen city';
  end if;

  update public.profiles
  set role = p_role, is_active = p_active, team_role = p_team_role, city_id = p_city_id, warehouse_id = p_warehouse_id
  where id = p_user;
end;
$$;

-- The old role-only function keeps working for existing callers but now
-- needs team:edit instead of plain admin.
create or replace function public.admin_set_user_role(
  p_user   uuid,
  p_role   public.user_role,
  p_active boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('team', 'edit')) then
    raise exception 'You do not have permission to edit the team' using errcode = '42501';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'You cannot change your own role or status';
  end if;
  update public.profiles set role = p_role, is_active = p_active where id = p_user;
  if not found then raise exception 'User not found'; end if;
end;
$$;

-- Dashboard numbers now respect the caller's scope (a city manager sees their city).
create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today_start timestamptz :=
    date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
begin
  if not (select public.has_permission('dashboard', 'view')) then
    raise exception 'You do not have permission to see the dashboard' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'orders_today',
      (select count(*) from public.orders where created_at >= v_today_start and public.in_my_scope(city_id, warehouse_id)),
    'revenue_today',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= v_today_start and status <> 'cancelled' and public.in_my_scope(city_id, warehouse_id)),
    'revenue_7d',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= now() - interval '7 days' and status <> 'cancelled' and public.in_my_scope(city_id, warehouse_id)),
    'pending_restaurants',
      (select count(*) from public.restaurants where status = 'pending' and public.in_my_scope(city_id, warehouse_id)),
    'open_orders_by_status',
      (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
         select status, count(*) as n from public.orders
         where status not in ('delivered', 'cancelled') and public.in_my_scope(city_id, warehouse_id) group by status) s),
    'top_products_30d',
      (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
         select oi.product_name as name,
                sum(oi.quantity) as quantity,
                sum(oi.line_total) as revenue
         from public.order_items oi
         join public.orders o on o.id = oi.order_id
         where o.created_at >= now() - interval '30 days' and o.status <> 'cancelled'
           and public.in_my_scope(o.city_id, o.warehouse_id)
         group by oi.product_name
         order by sum(oi.line_total) desc
         limit 5) t)
  );
end;
$$;

create or replace function public.admin_outstanding_balances()
returns table (restaurant_id uuid, outstanding numeric, unpaid_orders bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select o.restaurant_id, sum(o.total_amount), count(*)
  from public.orders o
  where o.payment_status = 'unpaid' and o.status <> 'cancelled'
    and (select public.has_permission('customers', 'view'))
    and public.in_my_scope(o.city_id, o.warehouse_id)
  group by o.restaurant_id;
$$;

-- ---------- 15. Function permissions -----------------------------------------

revoke execute on function
  public.has_permission(text, text),
  public.is_super_admin(),
  public.in_my_scope(uuid, uuid),
  public.my_city_id(),
  public.warehouse_for_pincode(text),
  public.default_warehouse_id(),
  public.check_pincode(text),
  public.receive_stock(jsonb, uuid, text, uuid),
  public.adjust_stock(uuid, numeric, public.stock_reason, text, uuid),
  public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text),
  public.my_order_terms(),
  public.set_customer_status(uuid, public.restaurant_status),
  public.update_my_delivery_area(uuid, text),
  public.admin_list_users(),
  public.admin_set_team_member(uuid, public.user_role, boolean, text, uuid, uuid)
from public, anon;

grant execute on function
  public.has_permission(text, text),
  public.is_super_admin(),
  public.in_my_scope(uuid, uuid),
  public.my_city_id(),
  public.warehouse_for_pincode(text),
  public.default_warehouse_id(),
  public.receive_stock(jsonb, uuid, text, uuid),
  public.adjust_stock(uuid, numeric, public.stock_reason, text, uuid),
  public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text),
  public.my_order_terms(),
  public.set_customer_status(uuid, public.restaurant_status),
  public.update_my_delivery_area(uuid, text),
  public.admin_list_users(),
  public.admin_set_team_member(uuid, public.user_role, boolean, text, uuid, uuid)
to authenticated;

-- The website's pin-code checker runs logged out.
grant execute on function public.check_pincode(text) to anon, authenticated;

-- ---------- Cleanup (optional) -----------------------------------------------
-- Not callable by anyone; drop whenever convenient:
--   drop function public.apply_stock_movement_legacy(uuid, numeric, public.stock_reason, uuid, uuid, numeric, text);
--   drop function public.receive_stock_legacy(jsonb, uuid, text);
--   drop function public.adjust_stock_legacy(uuid, numeric, public.stock_reason, text);
--   drop function public.place_order_v2_legacy(jsonb, text, date, public.delivery_slot, public.payment_method);
--   drop function public.admin_list_users_legacy();
