-- =============================================================================
-- Migration 001: Core schema
-- Fresh Supply B2B — tables, enums, indexes, timestamps.
--
-- Conventions used across this database (read once, applies everywhere):
--   * Primary keys are uuid (gen_random_uuid()), except order_number which is a
--     human-friendly label shown to users.
--   * Every table has created_at; mutable tables also have updated_at, kept in
--     sync by the set_updated_at() trigger.
--   * Money is numeric(12,2), always INR. Never float.
--   * Orders SNAPSHOT product name/unit/price at order time, so later catalogue
--     edits never rewrite history.
--   * Browsers never write orders directly: see migration 003 (RPC functions).
-- =============================================================================

-- ---------- Enums -------------------------------------------------------------

create type public.user_role as enum ('admin', 'restaurant', 'delivery');

create type public.restaurant_status as enum ('pending', 'approved', 'suspended');

create type public.order_status as enum (
  'placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled'
);

-- ---------- Shared trigger: keep updated_at fresh -----------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- profiles: one row per login (extends auth.users) ------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        public.user_role not null default 'restaurant',
  full_name   text not null default '',
  phone       text,
  is_active   boolean not null default true,   -- false = login blocked by RLS
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is
  'One row per user. role decides which app they can use. Role changes only via admin_set_user_role().';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------- restaurants: the customer business, owned by one login ------------

create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null unique references public.profiles (id) on delete restrict,
  name        text not null check (length(trim(name)) > 0),
  address     text not null default '',
  phone       text,
  gstin       text,
  status      public.restaurant_status not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.restaurants is
  'A customer business. Starts as pending; an admin must approve before it can order.';

create trigger restaurants_set_updated_at
  before update on public.restaurants
  for each row execute function public.set_updated_at();

-- ---------- catalogue ---------------------------------------------------------

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  sort_order  integer not null default 0
);

create table public.products (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null unique check (length(trim(sku)) > 0),
  name           text not null check (length(trim(name)) > 0),
  description    text,
  category_id    uuid not null references public.categories (id) on delete restrict,
  price          numeric(12,2) not null check (price >= 0),   -- INR per unit
  unit           text not null check (length(trim(unit)) > 0), -- e.g. '25 kg case'
  min_order_qty  numeric(10,2) not null default 1 check (min_order_qty > 0),
  in_stock       boolean not null default true,   -- temporary: out of stock today
  is_active      boolean not null default true,   -- permanent: hidden from catalogue
  photo_path     text,                            -- path inside the product-photos bucket
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on column public.products.in_stock is 'Daily toggle. Visible but not orderable when false.';
comment on column public.products.is_active is 'Soft delete. Inactive products are hidden but kept for order history.';

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------- orders ------------------------------------------------------------

create sequence public.order_number_seq start 1000;

create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  order_number      text not null unique
                      default ('ORD-' || nextval('public.order_number_seq')::text),
  restaurant_id     uuid not null references public.restaurants (id) on delete restrict,
  placed_by         uuid not null references public.profiles (id),
  assigned_to       uuid references public.profiles (id),      -- delivery user
  status            public.order_status not null default 'placed',
  -- Snapshots, so the delivery person never needs access to the restaurants table
  restaurant_name   text not null,
  delivery_address  text not null,
  contact_phone     text,
  notes             text,
  total_amount      numeric(12,2) not null default 0 check (total_amount >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  product_id    uuid not null references public.products (id) on delete restrict,
  product_name  text not null,                       -- snapshot
  unit          text not null,                       -- snapshot
  unit_price    numeric(12,2) not null check (unit_price >= 0),  -- snapshot
  quantity      numeric(10,2) not null check (quantity > 0),
  line_total    numeric(12,2) generated always as (round(unit_price * quantity, 2)) stored,
  unique (order_id, product_id)
);

-- Audit trail: every status change, who did it, when.
create table public.order_status_history (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  from_status  public.order_status,
  to_status    public.order_status not null,
  changed_by   uuid references public.profiles (id),
  note         text,
  created_at   timestamptz not null default now()
);

-- ---------- Indexes (every foreign key we filter or join on) ------------------

create index products_category_idx        on public.products (category_id);
create index orders_restaurant_created_idx on public.orders (restaurant_id, created_at desc);
create index orders_assigned_idx          on public.orders (assigned_to) where assigned_to is not null;
create index orders_status_idx            on public.orders (status);
create index orders_placed_by_idx         on public.orders (placed_by);
create index order_items_order_idx        on public.order_items (order_id);
create index order_items_product_idx      on public.order_items (product_id);
create index order_history_order_idx      on public.order_status_history (order_id, created_at);
create index order_history_changed_by_idx on public.order_status_history (changed_by);
