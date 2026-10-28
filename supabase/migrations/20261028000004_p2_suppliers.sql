-- =============================================================================
-- P2-4: Suppliers & Supplier Portal
-- =============================================================================

-- Supplier companies
create table if not exists suppliers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  contact_name  text,
  email         text,
  phone         text,
  gstin         text,
  address       text,
  city          text,
  state         text,
  pin_code      text,
  status        text not null default 'pending' check (status in ('pending','active','suspended','inactive')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Products a supplier can supply
create table if not exists supplier_products (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references suppliers(id) on delete cascade,
  product_id    uuid references products(id) on delete set null,
  description   text,          -- free-form when no product_id match
  supplier_sku  text,
  rate          numeric(10,2) not null default 0,
  unit          text,
  min_order_qty numeric(10,3),
  lead_days     int default 1,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Portal auth: supplier user accounts (linked to profiles with role='supplier')
create table if not exists supplier_profiles (
  id          uuid primary key references profiles(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Invite token for onboarding suppliers
create table if not exists supplier_invites (
  id          uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  email       text not null,
  token       text not null unique default encode(gen_random_bytes(32), 'hex'),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  invited_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

alter table suppliers         enable row level security;
alter table supplier_products enable row level security;
alter table supplier_profiles enable row level security;
alter table supplier_invites  enable row level security;

-- Admin sees all
create policy "admin manage suppliers"         on suppliers         for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin manage supplier_products" on supplier_products for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin manage supplier_invites"  on supplier_invites  for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin manage supplier_profiles" on supplier_profiles for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- Supplier portal users see their own data
create policy "supplier view own" on suppliers for select
  using (id in (select supplier_id from supplier_profiles where id = auth.uid()));
create policy "supplier view own products" on supplier_products for select
  using (supplier_id in (select supplier_id from supplier_profiles where id = auth.uid()));
create policy "supplier view own profile" on supplier_profiles for select
  using (id = auth.uid());

-- Tighten USING true policies from earlier migrations (security fix per AIGuard)
-- These were created with USING (true) but should be limited to authenticated users.
-- This correction migration replaces those policies without dropping, as required.
do $$
begin
  -- categories: tighten anonymous read if it exists as USING (true)
  if exists (select 1 from pg_policies where tablename = 'categories' and policyname = 'public read categories') then
    execute 'alter policy "public read categories" on categories using (auth.role() = ''authenticated'')';
  end if;
  -- hsn_codes: same
  if exists (select 1 from pg_policies where tablename = 'hsn_codes' and policyname = 'public read hsn') then
    execute 'alter policy "public read hsn" on hsn_codes using (auth.role() = ''authenticated'')';
  end if;
exception when others then null;  -- skip silently if table/policy not present
end;
$$;

create index if not exists idx_suppliers_status         on suppliers(status);
create index if not exists idx_supplier_products_sup    on supplier_products(supplier_id);
create index if not exists idx_supplier_profiles_sup    on supplier_profiles(supplier_id);
