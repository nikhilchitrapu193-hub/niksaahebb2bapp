-- =============================================================================
-- Migration 012: Fulfilment & delivery (build list section 6, Phase 1, batch 5).
--
--   receive → batches with expiry → pick list → pack → trip sheet → dispatch
--   (driver + vehicle, one POD OTP per order) → deliver with photo + OTP,
--   doorstep returns back to stock → COD cash collected → cash settled.
--
--   * Permission module "fulfilment" (view / edit / approve / export) and a
--     logistics_partner team role (a 3PL that only sees fulfilment, in its city).
--   * stock_batches: every accepted receipt line becomes a batch with its expiry.
--     expiring_batches() lists what is near or past expiry; write_off_expired()
--     posts the wastage. warehouse_stock stays the authoritative total; batches
--     are the expiry overlay reconciled by the write-off (ADR 0016).
--   * vehicles, trips + trip_orders (trip sheets). dispatch_trip() assigns the
--     driver and sends every packed order out for delivery with a POD OTP.
--   * pick_list(warehouse, date, slot): what to pick for a day's confirmed orders.
--   * complete_delivery(): the assigned driver marks delivered with a photo and
--     the OTP; doorstep returns reduce the billed lines and go back to stock;
--     a COD order's cash is recorded against the driver and the order marked paid.
--   * settle_driver_cash() / driver_cash_summary(): collected vs settled.
--   * delivery_charge_rules: per city + slot fee and free-above threshold, used
--     by place_order from migration 013 (batch 6 ships alongside this one).
--
-- Decision record: docs/adr/0016-fulfilment-batches-trips-pod.md
-- =============================================================================

-- ---------- 1. Permission module "fulfilment" and the logistics role ----------

do $$
begin
  execute 'alter table public.role_permissions drop constraint role_permissions_module_check';
  execute $c$alter table public.role_permissions add constraint role_permissions_module_check
    check (module in ('dashboard', 'orders', 'products', 'inventory', 'customers', 'payments',
                      'team', 'settings', 'audit', 'reports', 'pricing', 'procurement', 'fulfilment'))$c$;
end $$;

insert into public.team_roles (code, name, description, sort_order) values
  ('logistics_partner', 'Logistics partner', 'A third-party delivery partner: sees fulfilment for its city only.', 95)
on conflict (code) do nothing;

-- view = pick lists, trips, deliveries, batches; edit = build trips, dispatch,
-- write off expiry, record returns; approve = settle driver cash; export = CSV.
insert into public.role_permissions (team_role, module, action)
select v.role, 'fulfilment', a.action
from (values
  ('dispatcher',        'view,edit'),
  ('warehouse_manager', 'view,edit,export'),
  ('city_manager',      'view,edit,approve,export'),
  ('logistics_partner', 'view,edit'),
  ('finance',           'view,approve,export')     -- finance settles the cash
) as v (role, actions)
cross join lateral unnest(string_to_array(v.actions, ',')) as a (action)
on conflict do nothing;

-- ---------- 2. Stock batches and expiry -------------------------------------------

-- Each accepted receipt line becomes a batch. remaining_qty is the expiry
-- overlay, not the authoritative figure (that is warehouse_stock.qty): the
-- expiry write-off reduces a batch and posts the matching wastage movement, so
-- the two stay in step on the path that matters. See ADR 0016.
create table public.stock_batches (
  id            uuid primary key default gen_random_uuid(),
  warehouse_id  uuid not null references public.warehouses (id) on delete restrict,
  product_id    uuid not null references public.products (id) on delete restrict,
  grn_id        uuid references public.goods_receipts (id) on delete set null,
  batch_no      text,
  received_qty  numeric(12,2) not null check (received_qty > 0),
  remaining_qty numeric(12,2) not null check (remaining_qty >= 0),
  unit_cost     numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  expiry_date   date,
  received_at   timestamptz not null default now()
);
create index stock_batches_fefo_idx on public.stock_batches (warehouse_id, product_id, expiry_date nulls last, received_at)
  where remaining_qty > 0;
create index stock_batches_expiry_idx on public.stock_batches (expiry_date) where remaining_qty > 0 and expiry_date is not null;
comment on table public.stock_batches is
  'Receipts with an expiry date, for FEFO picking and expiry write-off. warehouse_stock.qty remains the authoritative total.';

-- Receipt lines remember the batch and expiry the receiver typed.
alter table public.goods_receipt_items
  add column batch_no    text,
  add column expiry_date date;

-- Re-emit receive_goods (migration 011) so an accepted line also opens a batch.
-- Items may carry 'batch_no' and 'expiry_date'; everything else is unchanged.
create or replace function public.receive_goods(
  p_warehouse_id    uuid,
  p_supplier_id     uuid,
  p_po_id           uuid,
  p_source          text,
  p_items           jsonb,
  p_note            text default null,
  p_bill_photo_path text default null,
  p_bill_amount     numeric default null,
  p_paid_cash       boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_wh       uuid := coalesce(p_warehouse_id, public.default_warehouse_id());
  v_city     uuid;
  v_po       public.purchase_orders;
  v_grn      uuid;
  v_num      text;
  v_line     record;
  v_item     public.purchase_order_items;
  v_supplier uuid := p_supplier_id;
  v_open     int;
begin
  if not (select public.has_permission('inventory', 'edit')) then
    raise exception 'You do not have permission to receive stock' using errcode = '42501';
  end if;
  select city_id into v_city from public.warehouses where id = v_wh;
  if v_city is null then raise exception 'Choose a warehouse'; end if;
  if not (select public.in_my_scope(v_city, v_wh)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;
  if p_source not in ('po', 'mandi', 'direct') then raise exception 'source must be po, mandi or direct'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one line';
  end if;

  if p_po_id is not null then
    select * into v_po from public.purchase_orders where id = p_po_id for update;
    if not found then raise exception 'Purchase order not found'; end if;
    if v_po.status not in ('sent', 'part_received') then
      raise exception 'Purchase order % is % — only sent or part-received orders can be received', v_po.po_number, v_po.status;
    end if;
    if v_po.warehouse_id <> v_wh then raise exception 'Purchase order % is for another warehouse', v_po.po_number; end if;
    v_supplier := v_po.supplier_id;
  end if;
  if p_source = 'mandi' and p_bill_amount is null then
    raise exception 'Enter the mandi bill amount';
  end if;

  insert into public.goods_receipts (po_id, supplier_id, warehouse_id, city_id, source, bill_photo_path, bill_amount, paid_cash, note, received_by)
  values (p_po_id, v_supplier, v_wh, v_city, p_source, p_bill_photo_path, p_bill_amount, coalesce(p_paid_cash, false), left(p_note, 500), v_uid)
  returning id, grn_number into v_grn, v_num;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id,
           coalesce((e ->> 'qty_accepted')::numeric, 0) as accepted,
           coalesce((e ->> 'qty_rejected')::numeric, 0) as rejected,
           (e ->> 'unit_cost')::numeric as unit_cost,
           e ->> 'grade' as grade, e ->> 'reject_reason' as reject_reason, e ->> 'photo_path' as photo_path,
           nullif(trim(e ->> 'batch_no'), '') as batch_no, (e ->> 'expiry_date')::date as expiry_date
    from jsonb_array_elements(p_items) as e
  loop
    if v_line.accepted < 0 or v_line.rejected < 0 or v_line.accepted + v_line.rejected <= 0 then
      raise exception 'Each line needs an accepted or rejected quantity';
    end if;
    if v_line.rejected > 0 and length(trim(coalesce(v_line.reject_reason, ''))) = 0 then
      raise exception 'Give a reason for the rejected quantity';
    end if;
    if p_po_id is not null then
      select * into v_item from public.purchase_order_items where po_id = p_po_id and product_id = v_line.product_id for update;
      if not found then
        raise exception '"%" is not on purchase order %', (select name from public.products where id = v_line.product_id), v_po.po_number;
      end if;
      update public.purchase_order_items
      set qty_received = qty_received + v_line.accepted, qty_rejected = qty_rejected + v_line.rejected
      where id = v_item.id;
      if v_line.unit_cost is null then v_line.unit_cost := v_item.unit_cost; end if;
    end if;

    insert into public.goods_receipt_items (grn_id, product_id, qty_accepted, qty_rejected, unit_cost, grade, reject_reason, photo_path, batch_no, expiry_date)
    values (v_grn, v_line.product_id, v_line.accepted, v_line.rejected, v_line.unit_cost, v_line.grade, v_line.reject_reason, v_line.photo_path, v_line.batch_no, v_line.expiry_date);

    -- Only what passed the check goes into stock (rule: the ledger holds goods we can sell).
    if v_line.accepted > 0 then
      perform public.apply_stock_movement(v_wh, v_line.product_id, v_line.accepted, 'received', v_supplier, null, v_line.unit_cost, v_num);
      insert into public.stock_batches (warehouse_id, product_id, grn_id, batch_no, received_qty, remaining_qty, unit_cost, expiry_date)
      values (v_wh, v_line.product_id, v_grn, v_line.batch_no, v_line.accepted, v_line.accepted, v_line.unit_cost, v_line.expiry_date);
    end if;
  end loop;

  if p_po_id is not null then
    select count(*) into v_open from public.purchase_order_items where po_id = p_po_id and qty_received + qty_rejected < qty_ordered;
    update public.purchase_orders
    set status = case when v_open = 0 then 'closed' else 'part_received' end,
        closed_at = case when v_open = 0 then now() end
    where id = p_po_id;
  end if;

  return jsonb_build_object('id', v_grn, 'grn_number', v_num,
                            'po_status', (select status from public.purchase_orders where id = p_po_id));
end;
$$;

-- Batches at or within p_within_days of expiry (0 = already expired), newest-expiry last.
create function public.expiring_batches(p_warehouse_id uuid, p_within_days integer default 3)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_city uuid;
begin
  if not (select public.has_permission('fulfilment', 'view')) and not (select public.has_permission('inventory', 'view')) then
    raise exception 'You do not have permission to view batches' using errcode = '42501';
  end if;
  select city_id into v_city from public.warehouses where id = p_warehouse_id;
  if not (select public.in_my_scope(v_city, p_warehouse_id)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;
  return query
    select jsonb_build_object(
      'id', b.id, 'product_id', b.product_id, 'sku', p.sku, 'name', p.name, 'unit', p.unit,
      'batch_no', b.batch_no, 'remaining_qty', b.remaining_qty, 'unit_cost', b.unit_cost,
      'expiry_date', b.expiry_date,
      'days_left', (b.expiry_date - (now() at time zone 'Asia/Kolkata')::date),
      'expired', (b.expiry_date < (now() at time zone 'Asia/Kolkata')::date))
    from public.stock_batches b join public.products p on p.id = b.product_id
    where b.warehouse_id = p_warehouse_id and b.remaining_qty > 0 and b.expiry_date is not null
      and b.expiry_date <= (now() at time zone 'Asia/Kolkata')::date + p_within_days
    order by b.expiry_date, p.name;
end;
$$;

-- Write off every batch already past its expiry: post wastage and zero the batch.
-- Returns {batches, qty}. Needs inventory:edit (it changes stock) and scope.
create function public.write_off_expired(p_warehouse_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_city  uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_b     record;
  v_batches int := 0;
  v_qty   numeric := 0;
begin
  if not (select public.has_permission('inventory', 'edit')) then
    raise exception 'You do not have permission to write off stock' using errcode = '42501';
  end if;
  select city_id into v_city from public.warehouses where id = p_warehouse_id;
  if v_city is null then raise exception 'Choose a warehouse'; end if;
  if not (select public.in_my_scope(v_city, p_warehouse_id)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;

  for v_b in
    select * from public.stock_batches
    where warehouse_id = p_warehouse_id and remaining_qty > 0 and expiry_date is not null and expiry_date < v_today
    for update
  loop
    -- Never drive warehouse_stock below zero if a batch over-counts (e.g. sold before write-off).
    perform public.apply_stock_movement(
      p_warehouse_id, v_b.product_id,
      -least(v_b.remaining_qty, (select qty from public.warehouse_stock where warehouse_id = p_warehouse_id and product_id = v_b.product_id)),
      'wastage', null, null, v_b.unit_cost,
      'expired batch ' || coalesce(v_b.batch_no, v_b.id::text) || ' (' || v_b.expiry_date || ')');
    update public.stock_batches set remaining_qty = 0 where id = v_b.id;
    v_batches := v_batches + 1;
    v_qty := v_qty + v_b.remaining_qty;
  end loop;

  return jsonb_build_object('batches', v_batches, 'qty', v_qty);
end;
$$;

-- ---------- 3. Vehicles -----------------------------------------------------------

create table public.vehicles (
  id           uuid primary key default gen_random_uuid(),
  city_id      uuid not null references public.cities (id) on delete restrict,
  registration text not null unique,
  label        text,
  capacity_note text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index vehicles_city_idx on public.vehicles (city_id);

-- ---------- 4. Trips (trip sheets) ------------------------------------------------

create sequence public.trip_number_seq start 1000;

create table public.trips (
  id            uuid primary key default gen_random_uuid(),
  trip_number   text not null unique default ('TRIP-' || nextval('public.trip_number_seq')::text),
  city_id       uuid not null references public.cities (id) on delete restrict,
  warehouse_id  uuid not null references public.warehouses (id) on delete restrict,
  driver_id     uuid references public.profiles (id) on delete set null,
  vehicle_id    uuid references public.vehicles (id) on delete set null,
  trip_date     date not null,
  slot          public.delivery_slot,
  status        text not null default 'draft' check (status in ('draft', 'dispatched', 'closed', 'cancelled')),
  notes         text,
  created_by    uuid references public.profiles (id) on delete set null,
  dispatched_at timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index trips_date_idx on public.trips (trip_date, slot);
create index trips_driver_idx on public.trips (driver_id);
create trigger trips_set_updated_at before update on public.trips for each row execute function public.set_updated_at();
comment on table public.trips is
  'A trip sheet: a driver + vehicle delivering a set of orders on one date/slot. draft → dispatched → closed.';

create table public.trip_orders (
  trip_id   uuid not null references public.trips (id) on delete cascade,
  order_id  uuid not null references public.orders (id) on delete cascade,
  stop_seq  integer not null default 1,
  primary key (trip_id, order_id),
  unique (order_id)                      -- an order belongs to at most one trip
);
create index trip_orders_order_idx on public.trip_orders (order_id);

-- ---------- 5. Proof of delivery, returns and cash on the order -------------------

alter table public.orders
  add column delivered_at  timestamptz,
  add column pod_photo_path text,
  add column pod_otp       text,
  add column pod_note      text,
  add column return_total  numeric(12,2) not null default 0 check (return_total >= 0);

-- What came back at the door, for the record (billing is reduced on the order itself).
create table public.delivery_returns (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  order_item_id uuid not null references public.order_items (id) on delete cascade,
  product_id    uuid not null references public.products (id) on delete restrict,
  qty           numeric(10,2) not null check (qty > 0),
  reason        text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index delivery_returns_order_idx on public.delivery_returns (order_id);

-- Cash the driver collected on COD deliveries, and the settlements against it.
create table public.driver_cash (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders (id) on delete restrict,
  driver_id   uuid not null references public.profiles (id) on delete restrict,
  amount      numeric(12,2) not null check (amount >= 0),
  collected_at timestamptz not null default now(),
  unique (order_id)
);
create index driver_cash_driver_idx on public.driver_cash (driver_id);

create table public.cash_settlements (
  id          uuid primary key default gen_random_uuid(),
  driver_id   uuid not null references public.profiles (id) on delete restrict,
  amount      numeric(12,2) not null check (amount > 0),
  note        text,
  settled_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index cash_settlements_driver_idx on public.cash_settlements (driver_id);

-- Private bucket for delivery photos (the POD). Staff read; the driver app uploads.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-pod', 'delivery-pod', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy delivery_pod_select on storage.objects for select to authenticated
  using (bucket_id = 'delivery-pod' and ((select public.has_permission('fulfilment', 'view')) or (select public.app_role()) = 'delivery'));
create policy delivery_pod_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'delivery-pod' and (select public.app_role()) in ('delivery', 'admin'));

-- ---------- 6. Delivery charge rules (used by place_order in migration 013) -------

create table public.delivery_charge_rules (
  id          uuid primary key default gen_random_uuid(),
  city_id     uuid references public.cities (id) on delete cascade,   -- NULL = every city
  slot        public.delivery_slot,                                   -- NULL = every slot
  fee         numeric(12,2) not null default 0 check (fee >= 0),
  free_above  numeric(12,2) check (free_above is null or free_above >= 0),
  is_active   boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- One rule per (city, slot), counting NULL (= "any") as its own value. Four
-- partial indexes cover the null/not-null combinations without a non-immutable
-- enum→text cast in the index expression.
create unique index delivery_charge_rules_city_slot_idx on public.delivery_charge_rules (city_id, slot) where city_id is not null and slot is not null;
create unique index delivery_charge_rules_city_idx      on public.delivery_charge_rules (city_id)       where city_id is not null and slot is null;
create unique index delivery_charge_rules_slot_idx      on public.delivery_charge_rules (slot)          where city_id is null and slot is not null;
create unique index delivery_charge_rules_any_idx       on public.delivery_charge_rules ((true))        where city_id is null and slot is null;
create trigger delivery_charge_rules_set_updated_at before update on public.delivery_charge_rules for each row execute function public.set_updated_at();
comment on table public.delivery_charge_rules is
  'Per city and / or slot: the delivery fee and a free-above threshold. The most specific active rule wins; no rule = the sector fee from place_order. Consulted by delivery_fee_for().';

-- The fee for a delivery, given the order subtotal. Falls back to the caller's
-- sector fee (p_sector_fee) with the sector minimum (p_sector_mov) when no rule
-- matches. Returns {fee, free_above, source}.
create function public.delivery_fee_for(p_city_id uuid, p_slot public.delivery_slot, p_subtotal numeric, p_sector_mov numeric, p_sector_fee numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rule public.delivery_charge_rules;
begin
  select * into v_rule from public.delivery_charge_rules
  where is_active and (city_id is null or city_id = p_city_id) and (slot is null or slot = p_slot)
  order by (city_id is not null)::int + (slot is not null)::int desc
  limit 1;

  if found then
    if v_rule.free_above is not null and p_subtotal >= v_rule.free_above then
      return jsonb_build_object('fee', 0, 'free_above', v_rule.free_above, 'source', 'rule');
    end if;
    return jsonb_build_object('fee', v_rule.fee, 'free_above', v_rule.free_above, 'source', 'rule');
  end if;

  -- No rule: the sector's minimum-order fee (what place_order did before batch 5).
  if coalesce(p_sector_mov, 0) > 0 and p_subtotal < p_sector_mov then
    return jsonb_build_object('fee', coalesce(p_sector_fee, 0), 'free_above', p_sector_mov, 'source', 'sector');
  end if;
  return jsonb_build_object('fee', 0, 'free_above', p_sector_mov, 'source', 'sector');
end;
$$;

-- ---------- 7. Pick list ----------------------------------------------------------

-- What to pick for a warehouse, date and slot: per product the quantity ordered
-- across confirmed-but-not-yet-packed orders, the order count and free stock.
create function public.pick_list(p_warehouse_id uuid, p_delivery_date date, p_slot public.delivery_slot default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_city uuid;
begin
  if not (select public.has_permission('fulfilment', 'view')) then
    raise exception 'You do not have permission to view the pick list' using errcode = '42501';
  end if;
  select city_id into v_city from public.warehouses where id = p_warehouse_id;
  if not (select public.in_my_scope(v_city, p_warehouse_id)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;
  return query
    select jsonb_build_object(
      'product_id', i.product_id, 'sku', p.sku, 'name', p.name, 'unit', p.unit,
      'category_name', public.category_path(p.category_id),
      'pick_qty', sum(i.ordered_quantity), 'orders', count(distinct o.id),
      'free_stock', coalesce(ws.qty, 0),
      'short', greatest(0, sum(i.ordered_quantity) - coalesce(ws.qty, 0)))
    from public.orders o
    join public.order_items i on i.order_id = o.id
    join public.products p on p.id = i.product_id
    left join public.warehouse_stock ws on ws.product_id = i.product_id and ws.warehouse_id = p_warehouse_id
    where o.warehouse_id = p_warehouse_id and o.delivery_date = p_delivery_date
      and o.status = 'confirmed'
      and (p_slot is null or o.delivery_slot = p_slot)
    group by i.product_id, p.sku, p.name, p.unit, p.category_id, ws.qty
    order by p.name;
end;
$$;

-- ---------- 8. Trip functions -----------------------------------------------------

-- Build a trip (fulfilment:edit, in scope). p_order_ids: packed/confirmed orders
-- in the same warehouse. Returns {id, trip_number}.
create function public.create_trip(
  p_driver_id   uuid,
  p_vehicle_id  uuid,
  p_trip_date   date,
  p_slot        public.delivery_slot,
  p_order_ids   uuid[],
  p_notes       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_wh   uuid;
  v_city uuid;
  v_trip uuid;
  v_num  text;
  v_oid  uuid;
  v_seq  int := 0;
  v_order public.orders;
begin
  if not (select public.has_permission('fulfilment', 'edit')) then
    raise exception 'You do not have permission to build trips' using errcode = '42501';
  end if;
  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    raise exception 'Add at least one order to the trip';
  end if;
  if p_driver_id is not null and not exists (select 1 from public.profiles where id = p_driver_id and role = 'delivery' and is_active) then
    raise exception 'Choose an active delivery account for the driver';
  end if;

  -- The warehouse comes from the first order; every order must share it and be in scope.
  select warehouse_id, city_id into v_wh, v_city from public.orders where id = p_order_ids[1];
  if v_wh is null then raise exception 'Order not found'; end if;
  if not (select public.in_my_scope(v_city, v_wh)) then
    raise exception 'These orders are outside your scope' using errcode = '42501';
  end if;

  insert into public.trips (city_id, warehouse_id, driver_id, vehicle_id, trip_date, slot, notes, created_by)
  values (v_city, v_wh, p_driver_id, p_vehicle_id, p_trip_date, p_slot, left(p_notes, 500), v_uid)
  returning id, trip_number into v_trip, v_num;

  foreach v_oid in array p_order_ids loop
    select * into v_order from public.orders where id = v_oid for update;
    if not found then raise exception 'Order not found'; end if;
    if v_order.warehouse_id <> v_wh then raise exception 'All orders on a trip must be from the same warehouse'; end if;
    if v_order.status not in ('confirmed', 'packed') then
      raise exception 'Order % is % — only confirmed or packed orders can go on a trip', v_order.order_number, v_order.status;
    end if;
    v_seq := v_seq + 1;
    insert into public.trip_orders (trip_id, order_id, stop_seq) values (v_trip, v_oid, v_seq);
  end loop;

  return jsonb_build_object('id', v_trip, 'trip_number', v_num);
end;
$$;

-- Replace a draft trip's driver, vehicle and stops.
create function public.update_trip(p_trip_id uuid, p_driver_id uuid, p_vehicle_id uuid, p_notes text, p_order_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips;
  v_oid  uuid;
  v_seq  int := 0;
  v_order public.orders;
begin
  if not (select public.has_permission('fulfilment', 'edit')) then
    raise exception 'You do not have permission to change trips' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found then raise exception 'Trip not found'; end if;
  if not (select public.in_my_scope(v_trip.city_id, v_trip.warehouse_id)) then
    raise exception 'This trip is outside your scope' using errcode = '42501';
  end if;
  if v_trip.status <> 'draft' then raise exception 'Only a draft trip can be changed (this one is %)', v_trip.status; end if;
  if p_driver_id is not null and not exists (select 1 from public.profiles where id = p_driver_id and role = 'delivery' and is_active) then
    raise exception 'Choose an active delivery account for the driver';
  end if;

  delete from public.trip_orders where trip_id = p_trip_id;
  if p_order_ids is not null then
    foreach v_oid in array p_order_ids loop
      select * into v_order from public.orders where id = v_oid for update;
      if not found then raise exception 'Order not found'; end if;
      if v_order.warehouse_id <> v_trip.warehouse_id then raise exception 'All orders on a trip must share the trip warehouse'; end if;
      if v_order.status not in ('confirmed', 'packed') then
        raise exception 'Order % is % — only confirmed or packed orders can go on a trip', v_order.order_number, v_order.status;
      end if;
      v_seq := v_seq + 1;
      insert into public.trip_orders (trip_id, order_id, stop_seq) values (p_trip_id, v_oid, v_seq);
    end loop;
  end if;

  update public.trips set driver_id = p_driver_id, vehicle_id = p_vehicle_id, notes = left(p_notes, 500) where id = p_trip_id;
end;
$$;

-- Dispatch the trip: every packed order goes out for delivery under this driver,
-- each with a 4-digit POD OTP. Orders still only 'confirmed' are rejected (pack first).
create function public.dispatch_trip(p_trip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_trip public.trips;
  v_o    record;
  v_n    int := 0;
  v_otp  text;
begin
  if not (select public.has_permission('fulfilment', 'edit')) then
    raise exception 'You do not have permission to dispatch trips' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found then raise exception 'Trip not found'; end if;
  if not (select public.in_my_scope(v_trip.city_id, v_trip.warehouse_id)) then
    raise exception 'This trip is outside your scope' using errcode = '42501';
  end if;
  if v_trip.status <> 'draft' then raise exception 'This trip is already %', v_trip.status; end if;
  if v_trip.driver_id is null then raise exception 'Assign a driver before dispatching'; end if;
  if not exists (select 1 from public.trip_orders where trip_id = p_trip_id) then raise exception 'This trip has no orders'; end if;

  for v_o in
    select o.* from public.orders o join public.trip_orders t on t.order_id = o.id
    where t.trip_id = p_trip_id for update
  loop
    if v_o.status <> 'packed' then
      raise exception 'Order % is % — pack every order before dispatching the trip', v_o.order_number, v_o.status;
    end if;
    v_otp := lpad((floor(random() * 10000))::int::text, 4, '0');
    update public.orders set assigned_to = v_trip.driver_id, status = 'out_for_delivery', pod_otp = v_otp where id = v_o.id;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (v_o.id, 'packed', 'out_for_delivery', v_uid, 'Dispatched on ' || v_trip.trip_number);
    v_n := v_n + 1;
  end loop;

  update public.trips set status = 'dispatched', dispatched_at = now() where id = p_trip_id;
  return jsonb_build_object('dispatched', v_n);
end;
$$;

-- Close or cancel a trip. Closing is a tidy-up once its orders are delivered;
-- cancelling is only allowed while still a draft.
create function public.set_trip_status(p_trip_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips;
begin
  if not (select public.has_permission('fulfilment', 'edit')) then
    raise exception 'You do not have permission to change trips' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found then raise exception 'Trip not found'; end if;
  if not (select public.in_my_scope(v_trip.city_id, v_trip.warehouse_id)) then
    raise exception 'This trip is outside your scope' using errcode = '42501';
  end if;
  if p_status = 'closed' then
    if v_trip.status <> 'dispatched' then raise exception 'Only a dispatched trip can be closed'; end if;
    update public.trips set status = 'closed', closed_at = now() where id = p_trip_id;
  elsif p_status = 'cancelled' then
    if v_trip.status <> 'draft' then raise exception 'Only a draft trip can be cancelled (dispatched orders are already out)'; end if;
    update public.trips set status = 'cancelled' where id = p_trip_id;
  else
    raise exception 'Unknown trip status %', p_status;
  end if;
end;
$$;

-- ---------- 9. Complete a delivery: POD, returns, cash ----------------------------

-- The assigned driver (or fulfilment:edit staff) marks an out-for-delivery order
-- delivered. p_returns = [{order_item_id, qty, reason}] are doorstep refusals:
-- they reduce the billed line and go back to stock. A COD order's cash (the new
-- total) is recorded against the driver and the order marked paid.
create function public.complete_delivery(
  p_order_id uuid,
  p_otp      text default null,
  p_photo_path text default null,
  p_note     text default null,
  p_returns  jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_role    public.user_role := (select public.app_role());
  v_order   public.orders;
  v_line    record;
  v_item    public.order_items;
  v_subtotal numeric(12,2);
  v_tax     numeric(12,2);
  v_total   numeric(12,2);
  v_returned numeric(12,2) := 0;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;

  -- The assigned driver, or staff with fulfilment:edit in scope.
  if not ((v_role = 'delivery' and v_order.assigned_to = v_uid)
          or ((select public.has_permission('fulfilment', 'edit')) and (select public.in_my_scope(v_order.city_id, v_order.warehouse_id)))) then
    raise exception 'You cannot complete this delivery' using errcode = '42501';
  end if;
  if v_order.status <> 'out_for_delivery' then
    raise exception 'Order % is % — only an out-for-delivery order can be completed', v_order.order_number, v_order.status;
  end if;
  if v_order.pod_otp is not null and p_otp is distinct from v_order.pod_otp then
    raise exception 'The delivery code does not match. Ask the customer for the 4-digit code.';
  end if;

  -- Doorstep returns: reduce the billed quantity, put the stock back.
  if p_returns is not null and jsonb_typeof(p_returns) = 'array' then
    for v_line in
      select (e ->> 'order_item_id')::uuid as item_id, (e ->> 'qty')::numeric as qty, e ->> 'reason' as reason
      from jsonb_array_elements(p_returns) as e
    loop
      select * into v_item from public.order_items where id = v_line.item_id and order_id = p_order_id for update;
      if not found then raise exception 'That line is not on this order'; end if;
      if v_line.qty is null or v_line.qty <= 0 then raise exception 'A return quantity must be more than 0'; end if;
      if v_line.qty >= v_item.quantity then
        raise exception 'Cannot return the whole "%" at the door — refuse the order instead (support cancels it)', v_item.product_name;
      end if;
      perform public.apply_stock_movement(v_order.warehouse_id, v_item.product_id, v_line.qty, 'returned', null, p_order_id, null,
                                          'doorstep return ' || v_order.order_number);
      update public.order_items set quantity = quantity - v_line.qty where id = v_item.id;
      insert into public.delivery_returns (order_id, order_item_id, product_id, qty, reason, created_by)
      values (p_order_id, v_item.id, v_item.product_id, v_line.qty, left(v_line.reason, 200), v_uid);
      v_returned := v_returned + round(v_item.unit_price * v_line.qty, 2);
    end loop;
  end if;

  -- Re-total if anything came back (delivery fee stays as decided at order time).
  if v_returned > 0 then
    select coalesce(sum(line_total), 0), coalesce(sum(tax_amount), 0) into v_subtotal, v_tax
    from public.order_items where order_id = p_order_id;
    update public.orders
    set subtotal = v_subtotal, tax_amount = v_tax, return_total = return_total + v_returned,
        total_amount = v_subtotal + v_tax + coalesce(delivery_fee, 0)
    where id = p_order_id;
  end if;

  select * into v_order from public.orders where id = p_order_id;   -- refresh totals

  update public.orders
  set status = 'delivered', delivered_at = now(),
      pod_photo_path = coalesce(p_photo_path, pod_photo_path), pod_note = left(p_note, 300)
  where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, 'out_for_delivery', 'delivered', v_uid, left(p_note, 300));

  -- COD cash collected at the door (= the final total). Credit orders settle later.
  if v_order.payment_method = 'cod' and v_order.payment_status <> 'paid' then
    insert into public.driver_cash (order_id, driver_id, amount)
    values (p_order_id, coalesce(v_order.assigned_to, v_uid), v_order.total_amount)
    on conflict (order_id) do nothing;
    update public.orders set payment_status = 'paid', paid_at = now() where id = p_order_id;
  end if;

  return jsonb_build_object('id', p_order_id, 'total_amount', v_order.total_amount, 'returned', v_returned,
                            'cash_collected', case when v_order.payment_method = 'cod' and v_order.payment_status <> 'paid' then v_order.total_amount else 0 end);
end;
$$;

-- ---------- 10. Driver cash settlement --------------------------------------------

create function public.settle_driver_cash(p_driver_id uuid, p_amount numeric, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('fulfilment', 'approve')) and not (select public.has_permission('payments', 'edit')) then
    raise exception 'You do not have permission to settle driver cash' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The settled amount must be more than 0'; end if;
  if not exists (select 1 from public.profiles where id = p_driver_id and role = 'delivery') then
    raise exception 'That is not a delivery account';
  end if;
  insert into public.cash_settlements (driver_id, amount, note, settled_by)
  values (p_driver_id, p_amount, left(p_note, 300), (select auth.uid()));
end;
$$;

-- Per driver: cash collected, settled and still in hand.
create function public.driver_cash_summary()
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('fulfilment', 'view')) and not (select public.has_permission('payments', 'view')) then
    raise exception 'You do not have permission to view driver cash' using errcode = '42501';
  end if;
  return query
    with collected as (select driver_id, sum(amount) as amt, count(*) as orders from public.driver_cash group by driver_id),
         settled   as (select driver_id, sum(amount) as amt from public.cash_settlements group by driver_id)
    select jsonb_build_object(
      'driver_id', p.id, 'driver_name', p.full_name,
      'collected', coalesce(c.amt, 0), 'orders', coalesce(c.orders, 0),
      'settled', coalesce(s.amt, 0), 'in_hand', coalesce(c.amt, 0) - coalesce(s.amt, 0))
    from public.profiles p
    left join collected c on c.driver_id = p.id
    left join settled s on s.driver_id = p.id
    where p.role = 'delivery' and (coalesce(c.amt, 0) <> 0 or coalesce(s.amt, 0) <> 0)
    order by coalesce(c.amt, 0) - coalesce(s.amt, 0) desc;
end;
$$;

-- ---------- 11. Audit -------------------------------------------------------------

create trigger audit_vehicles              after insert or update or delete on public.vehicles              for each row execute function public.write_audit_log();
create trigger audit_trips                 after insert or update or delete on public.trips                 for each row execute function public.write_audit_log();
create trigger audit_delivery_charge_rules after insert or update or delete on public.delivery_charge_rules for each row execute function public.write_audit_log();
create trigger audit_cash_settlements      after insert or update or delete on public.cash_settlements      for each row execute function public.write_audit_log();

-- ---------- 12. Row Level Security and grants -------------------------------------

alter table public.stock_batches         enable row level security;
alter table public.vehicles              enable row level security;
alter table public.trips                 enable row level security;
alter table public.trip_orders           enable row level security;
alter table public.delivery_returns      enable row level security;
alter table public.driver_cash           enable row level security;
alter table public.cash_settlements      enable row level security;
alter table public.delivery_charge_rules enable row level security;
revoke all on public.stock_batches, public.vehicles, public.trips, public.trip_orders,
              public.delivery_returns, public.driver_cash, public.cash_settlements, public.delivery_charge_rules from anon;

-- Batches: read with inventory:view or fulfilment:view, within scope. Written by functions only.
create policy stock_batches_select on public.stock_batches for select to authenticated
  using (((select public.has_permission('inventory', 'view')) or (select public.has_permission('fulfilment', 'view')))
         and (select public.in_my_scope((select city_id from public.warehouses w where w.id = warehouse_id), warehouse_id)));

-- Vehicles: read/write with fulfilment, within the vehicle's city.
create policy vehicles_select on public.vehicles for select to authenticated
  using ((select public.has_permission('fulfilment', 'view')) and (select public.in_my_scope(city_id, null)));
create policy vehicles_write on public.vehicles for all to authenticated
  using ((select public.has_permission('fulfilment', 'edit')) and (select public.in_my_scope(city_id, null)))
  with check ((select public.has_permission('fulfilment', 'edit')) and (select public.in_my_scope(city_id, null)));

-- Delivery charge rules: read with fulfilment or pricing view; written via screens (fulfilment:edit).
create policy delivery_charge_rules_select on public.delivery_charge_rules for select to authenticated
  using ((select public.has_permission('fulfilment', 'view')) or (select public.has_permission('pricing', 'view')));
create policy delivery_charge_rules_write on public.delivery_charge_rules for all to authenticated
  using ((select public.has_permission('fulfilment', 'edit'))) with check ((select public.has_permission('fulfilment', 'edit')));

-- Trips: staff with fulfilment:view in scope, or the trip's own driver.
create policy trips_select on public.trips for select to authenticated
  using (((select public.has_permission('fulfilment', 'view')) and (select public.in_my_scope(city_id, warehouse_id)))
         or driver_id = (select auth.uid()));
create policy trip_orders_select on public.trip_orders for select to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id
                 and (((select public.has_permission('fulfilment', 'view')) and (select public.in_my_scope(t.city_id, t.warehouse_id)))
                      or t.driver_id = (select auth.uid()))));

-- Returns and cash: fulfilment / payments view, within scope via the order.
create policy delivery_returns_select on public.delivery_returns for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and ((select public.has_permission('fulfilment', 'view')) or (select public.has_permission('orders', 'view')))
                 and (select public.in_my_scope(o.city_id, o.warehouse_id))));
create policy driver_cash_select on public.driver_cash for select to authenticated
  using ((select public.has_permission('fulfilment', 'view')) or (select public.has_permission('payments', 'view')) or driver_id = (select auth.uid()));
create policy cash_settlements_select on public.cash_settlements for select to authenticated
  using ((select public.has_permission('fulfilment', 'view')) or (select public.has_permission('payments', 'view')) or driver_id = (select auth.uid()));

revoke all on public.stock_batches, public.trips, public.trip_orders,
              public.delivery_returns, public.driver_cash, public.cash_settlements from authenticated;
grant select on public.stock_batches, public.trips, public.trip_orders,
                public.delivery_returns, public.driver_cash, public.cash_settlements to authenticated;

revoke execute on function public.expiring_batches(uuid, integer)                        from public, anon;
revoke execute on function public.write_off_expired(uuid)                                from public, anon;
revoke execute on function public.delivery_fee_for(uuid, public.delivery_slot, numeric, numeric, numeric) from public, anon;
revoke execute on function public.pick_list(uuid, date, public.delivery_slot)            from public, anon;
revoke execute on function public.create_trip(uuid, uuid, date, public.delivery_slot, uuid[], text) from public, anon;
revoke execute on function public.update_trip(uuid, uuid, uuid, text, uuid[])            from public, anon;
revoke execute on function public.dispatch_trip(uuid)                                    from public, anon;
revoke execute on function public.set_trip_status(uuid, text)                            from public, anon;
revoke execute on function public.complete_delivery(uuid, text, text, text, jsonb)       from public, anon;
revoke execute on function public.settle_driver_cash(uuid, numeric, text)                from public, anon;
revoke execute on function public.driver_cash_summary()                                  from public, anon;
grant execute on function public.expiring_batches(uuid, integer)                         to authenticated;
grant execute on function public.write_off_expired(uuid)                                 to authenticated;
grant execute on function public.delivery_fee_for(uuid, public.delivery_slot, numeric, numeric, numeric) to authenticated;
grant execute on function public.pick_list(uuid, date, public.delivery_slot)             to authenticated;
grant execute on function public.create_trip(uuid, uuid, date, public.delivery_slot, uuid[], text) to authenticated;
grant execute on function public.update_trip(uuid, uuid, uuid, text, uuid[])             to authenticated;
grant execute on function public.dispatch_trip(uuid)                                     to authenticated;
grant execute on function public.set_trip_status(uuid, text)                             to authenticated;
grant execute on function public.complete_delivery(uuid, text, text, text, jsonb)        to authenticated;
grant execute on function public.settle_driver_cash(uuid, numeric, text)                 to authenticated;
grant execute on function public.driver_cash_summary()                                   to authenticated;
