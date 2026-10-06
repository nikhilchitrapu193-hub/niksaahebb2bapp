-- =============================================================================
-- Migration 004 — Warehouse & inventory, suppliers, checkout fields, settings
--
-- Adds the operations side of a Hyperpure-style business:
--   * stock on hand per product, a movement ledger, suppliers and stock receipts
--   * delivery date / slot, payment method (cash or credit) and GST on orders
--   * a public (logged-out) view of the catalogue for the landing page
--   * a single company_settings row used on invoices
--   * place_order() now reserves stock; cancelling restores it
-- =============================================================================

-- ---------- Enums -------------------------------------------------------------

create type public.stock_reason as enum (
  'received',        -- goods received from a supplier (GRN)
  'order',           -- reserved by a customer order
  'order_cancelled', -- returned to stock when an order is cancelled
  'adjustment',      -- stock count correction
  'wastage',         -- spoiled / damaged / expired
  'returned'         -- customer return accepted back into stock
);

create type public.payment_method as enum ('cod', 'credit');
create type public.payment_status as enum ('unpaid', 'paid');
create type public.delivery_slot  as enum ('morning', 'afternoon', 'evening', 'express');

-- ---------- Products: stock, pricing and tax ----------------------------------

alter table public.products
  add column stock_qty           numeric(12,2) not null default 0 check (stock_qty >= 0),
  add column low_stock_threshold numeric(12,2) not null default 0 check (low_stock_threshold >= 0),
  add column market_price        numeric(12,2) check (market_price is null or market_price >= 0),
  add column gst_rate            numeric(4,2)  not null default 0 check (gst_rate between 0 and 100),
  add column brand               text;

comment on column public.products.stock_qty is 'Quantity on hand in the warehouse. Changed only through stock functions.';
comment on column public.products.market_price is 'Optional "market rate" shown struck through next to our price.';
comment on column public.products.gst_rate is 'GST percentage applied on invoices (0, 5, 12, 18, 28).';

-- ---------- Suppliers & stock movements --------------------------------------

create table public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  contact     text,
  phone       text,
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger suppliers_updated_at before update on public.suppliers
  for each row execute function public.set_updated_at();

-- Every change to stock_qty is one row here, so stock can always be explained.
create table public.stock_movements (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products (id) on delete restrict,
  qty_delta    numeric(12,2) not null check (qty_delta <> 0),
  reason       public.stock_reason not null,
  supplier_id  uuid references public.suppliers (id) on delete set null,
  order_id     uuid references public.orders (id) on delete set null,
  unit_cost    numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  note         text,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index stock_movements_order_idx   on public.stock_movements (order_id);
create index stock_movements_supplier_idx on public.stock_movements (supplier_id);

-- ---------- Orders: delivery, payment, tax -----------------------------------

alter table public.orders
  add column delivery_date   date,
  add column delivery_slot   public.delivery_slot,
  add column payment_method  public.payment_method not null default 'cod',
  add column payment_status  public.payment_status not null default 'unpaid',
  add column paid_at         timestamptz,
  add column subtotal        numeric(12,2) not null default 0,
  add column tax_amount      numeric(12,2) not null default 0;

alter table public.order_items
  add column gst_rate   numeric(4,2) not null default 0,
  add column tax_amount numeric(12,2) generated always as (round(quantity * unit_price * gst_rate / 100, 2)) stored;

-- Restaurants carry FSSAI licence numbers (required to buy from Hyperpure).
alter table public.restaurants add column fssai text;

-- ---------- Company settings (one row) ---------------------------------------

create table public.company_settings (
  id            boolean primary key default true check (id), -- only one row can exist
  name          text not null default 'Fresh Supply',
  address       text not null default '',
  phone         text not null default '',
  email         text not null default '',
  gstin         text not null default '',
  fssai         text not null default '',
  invoice_note  text not null default 'Thank you for your business.',
  updated_at    timestamptz not null default now()
);
insert into public.company_settings default values;
create trigger company_settings_updated_at before update on public.company_settings
  for each row execute function public.set_updated_at();

-- ---------- Row Level Security ----------------------------------------------

alter table public.suppliers        enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.company_settings enable row level security;

create policy suppliers_admin_all on public.suppliers
  for all to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

-- Movements are written only by the stock functions below; admins can read them.
create policy stock_movements_admin_select on public.stock_movements
  for select to authenticated
  using ((select public.app_role()) = 'admin');

create policy company_settings_select on public.company_settings
  for select to authenticated
  using ((select public.app_role()) is not null);

create policy company_settings_admin_update on public.company_settings
  for update to authenticated
  using ((select public.app_role()) = 'admin')
  with check ((select public.app_role()) = 'admin');

revoke insert, update, delete, truncate on public.stock_movements from authenticated;
revoke insert, delete, truncate on public.company_settings from authenticated;

-- Public catalogue: logged-out visitors may read categories and listed products
-- (name, price, stock) for the landing page. Nothing else is visible to them.
grant select on public.categories, public.products to anon;

create policy categories_public_select on public.categories
  for select to anon using (true);

create policy products_public_select on public.products
  for select to anon using (is_active);

-- ---------- Sign-up trigger now records FSSAI ---------------------------------

create or replace function public.handle_new_user()
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

  if v_rest_name is not null then
    insert into public.restaurants (owner_id, name, address, phone, gstin, fssai)
    values (
      new.id,
      left(v_rest_name, 120),
      left(coalesce(new.raw_user_meta_data ->> 'address', ''), 400),
      left(new.raw_user_meta_data ->> 'phone', 20),
      left(new.raw_user_meta_data ->> 'gstin', 20),
      left(new.raw_user_meta_data ->> 'fssai', 20)
    );
  end if;

  return new;
end;
$$;

-- Replace the 4-argument version with one that also takes FSSAI. The old
-- function is renamed (not dropped) so the migration tooling treats it as
-- non-destructive; the cleanup section at the end explains how to drop it.
alter function public.update_my_restaurant(text, text, text, text) rename to update_my_restaurant_legacy;
revoke execute on function public.update_my_restaurant_legacy(text, text, text, text) from public, anon, authenticated;

create function public.update_my_restaurant(
  p_name    text,
  p_address text,
  p_phone   text,
  p_gstin   text,
  p_fssai   text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Restaurant accounts only' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'Restaurant name is required';
  end if;

  update public.restaurants
  set name    = left(trim(p_name), 120),
      address = left(coalesce(p_address, ''), 400),
      phone   = left(p_phone, 20),
      gstin   = left(p_gstin, 20),
      fssai   = left(p_fssai, 20)
  where owner_id = (select auth.uid());

  if not found then raise exception 'No restaurant is linked to this account'; end if;
end;
$$;

-- ---------- Stock functions (admin only) -------------------------------------

-- Internal helper: apply one movement and keep products.stock_qty in step.
-- Not exposed to the API (no grant), so stock can only change through the
-- functions in this file.
create function public.apply_stock_movement(
  p_product_id uuid,
  p_qty_delta  numeric,
  p_reason     public.stock_reason,
  p_supplier   uuid default null,
  p_order_id   uuid default null,
  p_unit_cost  numeric default null,
  p_note       text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new numeric;
begin
  update public.products
  set stock_qty = stock_qty + p_qty_delta
  where id = p_product_id
  returning stock_qty into v_new;

  if not found then raise exception 'Product not found'; end if;
  if v_new < 0 then raise exception 'Stock cannot go below zero'; end if;

  insert into public.stock_movements
    (product_id, qty_delta, reason, supplier_id, order_id, unit_cost, note, created_by)
  values
    (p_product_id, p_qty_delta, p_reason, p_supplier, p_order_id, p_unit_cost, left(p_note, 300), (select auth.uid()));
end;
$$;

revoke execute on function public.apply_stock_movement(uuid, numeric, public.stock_reason, uuid, uuid, numeric, text)
  from public, anon, authenticated;

-- Goods received: p_items = [{"product_id": uuid, "quantity": 10, "unit_cost": 25.5}]
create function public.receive_stock(p_items jsonb, p_supplier_id uuid default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
begin
  if (select public.app_role()) is distinct from 'admin' then
    raise exception 'Admins only' using errcode = '42501';
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
    perform public.apply_stock_movement(v_line.product_id, v_line.qty, 'received',
                                        p_supplier_id, null, v_line.unit_cost, p_note);
  end loop;
end;
$$;

-- Set stock to an exact counted figure (or write off wastage / accept a return).
-- p_reason: 'adjustment' | 'wastage' | 'returned'
create function public.adjust_stock(
  p_product_id uuid,
  p_new_qty    numeric,
  p_reason     public.stock_reason default 'adjustment',
  p_note       text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current numeric;
begin
  if (select public.app_role()) is distinct from 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_reason not in ('adjustment', 'wastage', 'returned') then
    raise exception 'Reason must be adjustment, wastage or returned';
  end if;
  if p_new_qty is null or p_new_qty < 0 then
    raise exception 'New quantity must be zero or more';
  end if;

  select stock_qty into v_current from public.products where id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;
  if v_current = p_new_qty then return; end if;

  perform public.apply_stock_movement(p_product_id, p_new_qty - v_current, p_reason, null, null, null, p_note);
end;
$$;

-- ---------- place_order: slots, payment, GST, stock reservation --------------

alter function public.place_order(jsonb, text) rename to place_order_legacy;
revoke execute on function public.place_order_legacy(jsonb, text) from public, anon, authenticated;

create function public.place_order(
  p_items          jsonb,
  p_notes          text default null,
  p_delivery_date  date default null,
  p_delivery_slot  public.delivery_slot default 'morning',
  p_payment_method public.payment_method default 'cod'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_rest      public.restaurants;
  v_order_id  uuid;
  v_number    text;
  v_line      record;
  v_product   public.products;
  v_subtotal  numeric(12,2);
  v_tax       numeric(12,2);
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Only restaurant accounts can place orders' using errcode = '42501';
  end if;

  select * into v_rest from public.restaurants where owner_id = v_uid;
  if not found then
    raise exception 'No restaurant is linked to this account';
  end if;
  if v_rest.status <> 'approved' then
    raise exception 'Your restaurant is not approved yet (status: %). Please wait for admin approval.', v_rest.status;
  end if;
  if length(trim(v_rest.address)) = 0 then
    raise exception 'Add a delivery address to your restaurant profile before ordering';
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
                             notes, delivery_date, delivery_slot, payment_method)
  values (v_rest.id, v_uid, v_rest.name, v_rest.address, v_rest.phone,
          left(p_notes, 500), p_delivery_date, p_delivery_slot, p_payment_method)
  returning id, order_number into v_order_id, v_number;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id,
           sum((e ->> 'quantity')::numeric) as qty
    from jsonb_array_elements(p_items) as e
    group by 1
  loop
    -- Lock the product row: two restaurants cannot both take the last units.
    select * into v_product
    from public.products
    where id = v_line.product_id and is_active
    for update;

    if not found then
      raise exception 'Product % is not available', v_line.product_id;
    end if;
    if not v_product.in_stock then
      raise exception '"%" is out of stock today', v_product.name;
    end if;
    if v_line.qty is null or v_line.qty < v_product.min_order_qty or v_line.qty > 10000 then
      raise exception 'Quantity for "%" must be between % and 10000', v_product.name, v_product.min_order_qty;
    end if;
    if v_line.qty > v_product.stock_qty then
      raise exception 'Only % % of "%" available right now', v_product.stock_qty, v_product.unit, v_product.name;
    end if;

    insert into public.order_items (order_id, product_id, product_name, unit, unit_price, quantity, gst_rate)
    values (v_order_id, v_product.id, v_product.name, v_product.unit, v_product.price, v_line.qty, v_product.gst_rate);

    perform public.apply_stock_movement(v_product.id, -v_line.qty, 'order', null, v_order_id, null, v_number);
  end loop;

  select coalesce(sum(line_total), 0), coalesce(sum(tax_amount), 0)
  into v_subtotal, v_tax
  from public.order_items where order_id = v_order_id;

  update public.orders
  set subtotal = v_subtotal, tax_amount = v_tax, total_amount = v_subtotal + v_tax
  where id = v_order_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by)
  values (v_order_id, null, 'placed', v_uid);

  return jsonb_build_object('id', v_order_id, 'order_number', v_number, 'total_amount', v_subtotal + v_tax);
end;
$$;

-- ---------- set_order_status: restore stock on cancellation ------------------

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
    v_allowed := case v_order.status
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

  -- Cancelled orders give their stock back to the warehouse.
  if p_new = 'cancelled' then
    for v_item in select product_id, quantity from public.order_items where order_id = p_order_id loop
      perform public.apply_stock_movement(v_item.product_id, v_item.quantity, 'order_cancelled',
                                          null, p_order_id, null, v_order.order_number);
    end loop;
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, p_new, v_uid, left(p_note, 300));
end;
$$;

-- ---------- Payments (admin) --------------------------------------------------

create function public.set_order_payment(p_order_id uuid, p_status public.payment_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.app_role()) is distinct from 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  update public.orders
  set payment_status = p_status,
      paid_at = case when p_status = 'paid' then now() else null end
  where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
end;
$$;

-- Outstanding credit per restaurant (admin) — for the Customers screen.
create function public.admin_outstanding_balances()
returns table (restaurant_id uuid, outstanding numeric, unpaid_orders bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select o.restaurant_id, sum(o.total_amount), count(*)
  from public.orders o
  where o.payment_status = 'unpaid' and o.status <> 'cancelled'
    and (select public.app_role()) = 'admin'
  group by o.restaurant_id;
$$;

-- ---------- Function permissions ---------------------------------------------

revoke execute on function
  public.receive_stock(jsonb, uuid, text),
  public.adjust_stock(uuid, numeric, public.stock_reason, text),
  public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method),
  public.set_order_payment(uuid, public.payment_status),
  public.admin_outstanding_balances(),
  public.update_my_restaurant(text, text, text, text, text)
from public, anon;

grant execute on function
  public.receive_stock(jsonb, uuid, text),
  public.adjust_stock(uuid, numeric, public.stock_reason, text),
  public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method),
  public.set_order_payment(uuid, public.payment_status),
  public.admin_outstanding_balances(),
  public.update_my_restaurant(text, text, text, text, text)
to authenticated;

-- ---------- Cleanup (optional) -----------------------------------------------
-- The *_legacy functions above are kept only because automated tooling refuses
-- DROP statements. They are not callable by anyone. Remove them any time with:
--   drop function public.place_order_legacy(jsonb, text);
--   drop function public.update_my_restaurant_legacy(text, text, text, text);
