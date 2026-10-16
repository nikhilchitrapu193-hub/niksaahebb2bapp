-- =============================================================================
-- Migration 013: Orders + (build list section 7, Phase 1, batch 6).
--
--   * Slot config: per city + slot a cut-off hour and an optional capacity.
--     slot_open() says whether a slot still takes orders for a delivery date.
--   * place_order v6: one shared core (rebuild_order_lines) reused by the
--     customer's place_order, staff place_order_for (order on behalf of a
--     customer) and edit_order. The delivery fee now comes from
--     delivery_charge_rules (migration 012), falling back to the sector fee.
--   * edit_order: the customer changes a placed order before its cut-off; staff
--     change a placed or confirmed order before it is packed. Stock is returned
--     and re-reserved, the order re-priced and re-totalled.
--   * cancel_order: the customer cancels a placed order before cut-off; staff
--     cancel any order that is not delivered. Stock goes back either way.
--   * report_issue → resolve_issue → credit_notes: a customer reports a problem
--     with a delivered order; support resolves it, optionally raising a credit
--     note (applied to the account balance in batch 7, Payments & credit).
--
-- Decision record: docs/adr/0017-order-edit-slots-credit-notes.md
-- =============================================================================

-- ---------- 1. Slot config and the cut-off / capacity check -----------------------

create table public.slot_config (
  id            uuid primary key default gen_random_uuid(),
  city_id       uuid references public.cities (id) on delete cascade,   -- NULL = every city
  slot          public.delivery_slot not null,
  cutoff_hour   integer not null default 18 check (cutoff_hour between 0 and 23),  -- IST hour; order by this time
  capacity_orders integer check (capacity_orders is null or capacity_orders > 0),  -- NULL = no cap
  is_active     boolean not null default true,
  note          text,
  updated_at    timestamptz not null default now()
);
create unique index slot_config_city_slot_idx on public.slot_config (city_id, slot) where city_id is not null;
create unique index slot_config_slot_idx      on public.slot_config (slot)          where city_id is null;
comment on table public.slot_config is
  'Per city + slot: the cut-off hour (IST) to order for a delivery, and an optional per-day capacity. Most specific (city) wins. No row = always open, no cap.';
create trigger slot_config_set_updated_at before update on public.slot_config for each row execute function public.set_updated_at();

-- Can this slot still take an order for p_date? Returns {open, reason}.
-- Express (today): before the cut-off hour today. Scheduled: a next-day order
-- (tomorrow) must beat today's cut-off; later dates are always in time.
-- Capacity counts non-cancelled orders already on that city/date/slot.
create function public.slot_open(p_city_id uuid, p_date date, p_slot public.delivery_slot)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg   public.slot_config;
  v_now   timestamptz := now();
  v_today date := (v_now at time zone 'Asia/Kolkata')::date;
  v_hour  int  := extract(hour from (v_now at time zone 'Asia/Kolkata'))::int;
  v_count int;
begin
  select * into v_cfg from public.slot_config
  where is_active and slot = p_slot and (city_id is null or city_id = p_city_id)
  order by (city_id is not null)::int desc limit 1;

  if not found then
    return jsonb_build_object('open', true, 'reason', null);   -- no config = always open
  end if;

  if p_slot = 'express' then
    if v_hour >= v_cfg.cutoff_hour then
      return jsonb_build_object('open', false, 'reason', format('Express orders close at %s:00. Choose a scheduled slot.', v_cfg.cutoff_hour));
    end if;
  elsif p_date <= v_today + 1 and v_hour >= v_cfg.cutoff_hour then
    return jsonb_build_object('open', false, 'reason', format('Orders for tomorrow close at %s:00. Choose a later date.', v_cfg.cutoff_hour));
  end if;

  if v_cfg.capacity_orders is not null then
    select count(*) into v_count from public.orders
    where city_id = p_city_id and delivery_date = p_date and delivery_slot = p_slot and status <> 'cancelled';
    if v_count >= v_cfg.capacity_orders then
      return jsonb_build_object('open', false, 'reason', 'This slot is full for that day. Choose another slot or date.');
    end if;
  end if;

  return jsonb_build_object('open', true, 'reason', null);
end;
$$;

-- ---------- 2. Shared line builder -------------------------------------------------

-- Reserve stock, price and cost-snapshot every line of an order, replacing any
-- lines already there (stock returned first). Used by place_order, place_order_for
-- and edit_order. Returns {subtotal, tax}. Caller owns header, totals and history.
create function public.rebuild_order_lines(p_order_id uuid, p_restaurant public.restaurants, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old       record;
  v_line      record;
  v_product   public.products;
  v_available numeric;
  v_item_id   uuid;
  v_calc      jsonb;
  v_price     numeric;
  v_subtotal  numeric(12,2);
  v_tax       numeric(12,2);
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order must contain at least one item';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'An order can contain at most 100 lines';
  end if;

  -- Return any stock the current lines hold, then clear them.
  for v_old in select product_id, quantity from public.order_items where order_id = p_order_id loop
    perform public.apply_stock_movement(p_restaurant.warehouse_id, v_old.product_id, v_old.quantity, 'order_cancelled',
                                        null, p_order_id, null, 'order rebuilt');
  end loop;
  delete from public.order_line_costs where order_id = p_order_id;
  delete from public.order_items where order_id = p_order_id;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::numeric) as qty
    from jsonb_array_elements(p_items) as e group by 1
  loop
    select * into v_product from public.products
    where id = v_line.product_id and is_active
      and not exists (select 1 from public.product_city_availability a
                      where a.product_id = products.id and a.city_id = p_restaurant.city_id and not a.is_available);
    if not found then raise exception 'Product % is not available in your city', v_line.product_id; end if;
    if not v_product.in_stock then raise exception '"%" is out of stock today', v_product.name; end if;
    if v_line.qty is null or v_line.qty < v_product.min_order_qty or v_line.qty > 10000 then
      raise exception 'Quantity for "%" must be between % and 10000', v_product.name, v_product.min_order_qty;
    end if;

    select qty into v_available from public.warehouse_stock
    where warehouse_id = p_restaurant.warehouse_id and product_id = v_product.id for update;
    v_available := coalesce(v_available, 0);
    if v_line.qty > v_available then
      raise exception 'Only % % of "%" available right now', v_available, v_product.unit, v_product.name;
    end if;

    v_price := public.customer_price(v_product.id, p_restaurant.id);
    insert into public.order_items (order_id, product_id, product_name, unit, unit_price, quantity, ordered_quantity, gst_rate, hsn_code)
    values (p_order_id, v_product.id, v_product.name, v_product.unit, v_price, v_line.qty, v_line.qty, v_product.gst_rate, v_product.hsn_code)
    returning id into v_item_id;

    v_calc := public.price_calc(v_product.id);
    insert into public.order_line_costs (order_item_id, order_id, product_id, unit_cost, cost_method)
    values (v_item_id, p_order_id, v_product.id, (v_calc ->> 'landed_cost')::numeric, v_calc ->> 'cost_method');

    perform public.apply_stock_movement(p_restaurant.warehouse_id, v_product.id, -v_line.qty, 'order', null, p_order_id, null,
                                        (select order_number from public.orders where id = p_order_id));
  end loop;

  select coalesce(sum(line_total), 0), coalesce(sum(tax_amount), 0) into v_subtotal, v_tax
  from public.order_items where order_id = p_order_id;
  return jsonb_build_object('subtotal', v_subtotal, 'tax', v_tax);
end;
$$;

-- The order header + totals shared by place_order and place_order_for.
-- p_enforce_slot: customers obey the cut-off / capacity; staff may place late.
create function public.place_order_core(
  p_restaurant     public.restaurants,
  p_placed_by      uuid,
  p_items          jsonb,
  p_notes          text,
  p_delivery_date  date,
  p_delivery_slot  public.delivery_slot,
  p_payment_method public.payment_method,
  p_po_reference   text,
  p_enforce_slot   boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sector   public.sectors;
  v_mov      numeric(12,2);
  v_fee      numeric(12,2);
  v_feecalc  jsonb;
  v_order_id uuid;
  v_number   text;
  v_lines    jsonb;
  v_subtotal numeric(12,2);
  v_tax      numeric(12,2);
  v_total    numeric(12,2);
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_slotchk  jsonb;
begin
  if p_restaurant.status <> 'approved' then
    raise exception 'The customer account is not approved (status: %)', p_restaurant.status;
  end if;
  if length(trim(coalesce(p_restaurant.address, ''))) = 0 then
    raise exception 'Add a delivery address before ordering';
  end if;
  if p_restaurant.warehouse_id is null then
    raise exception 'We do not deliver to that area yet';
  end if;

  select * into v_sector from public.sectors where code = p_restaurant.sector_code;
  v_mov := coalesce(p_restaurant.min_order_value, v_sector.min_order_value, 0);

  if v_sector.needs_po_reference and length(trim(coalesce(p_po_reference, ''))) = 0 then
    raise exception 'A purchase order / indent number is required for % orders', v_sector.name;
  end if;

  -- Delivery date / slot.
  if p_delivery_slot = 'express' then
    p_delivery_date := v_today;
  else
    p_delivery_date := coalesce(p_delivery_date, v_today + 1);
    if p_delivery_date < v_today + 1 then raise exception 'Scheduled deliveries start from tomorrow. Choose Express for today.'; end if;
    if p_delivery_date > v_today + 7 then raise exception 'Delivery date must be within the next 7 days'; end if;
  end if;
  if p_enforce_slot then
    v_slotchk := public.slot_open(p_restaurant.city_id, p_delivery_date, p_delivery_slot);
    if not (v_slotchk ->> 'open')::boolean then raise exception '%', v_slotchk ->> 'reason'; end if;
  end if;

  insert into public.orders (restaurant_id, placed_by, restaurant_name, delivery_address, contact_phone,
                             notes, delivery_date, delivery_slot, payment_method,
                             city_id, warehouse_id, sector_code, po_reference)
  values (p_restaurant.id, p_placed_by, p_restaurant.name, p_restaurant.address, p_restaurant.phone,
          left(p_notes, 500), p_delivery_date, p_delivery_slot, p_payment_method,
          p_restaurant.city_id, p_restaurant.warehouse_id, p_restaurant.sector_code, left(nullif(trim(p_po_reference), ''), 60))
  returning id, order_number into v_order_id, v_number;

  v_lines := public.rebuild_order_lines(v_order_id, p_restaurant, p_items);
  v_subtotal := (v_lines ->> 'subtotal')::numeric;
  v_tax := (v_lines ->> 'tax')::numeric;

  -- Delivery fee: the charge rule for this city/slot, else the sector minimum.
  v_feecalc := public.delivery_fee_for(p_restaurant.city_id, p_delivery_slot, v_subtotal, v_mov,
                                       coalesce(p_restaurant.delivery_fee_below_mov, v_sector.delivery_fee_below_mov, 0));
  v_fee := (v_feecalc ->> 'fee')::numeric;
  if v_subtotal < v_mov and v_fee <= 0 then
    raise exception 'Minimum order value is %. Add % more to place this order.', v_mov, v_mov - v_subtotal;
  end if;

  v_total := v_subtotal + v_tax + v_fee;
  update public.orders set subtotal = v_subtotal, tax_amount = v_tax, delivery_fee = v_fee, total_amount = v_total
  where id = v_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by)
  values (v_order_id, null, 'placed', p_placed_by);

  return jsonb_build_object('id', v_order_id, 'order_number', v_number, 'total_amount', v_total, 'delivery_fee', v_fee);
end;
$$;

-- ---------- 3. place_order v6 (customer) and place_order_for (staff) ---------------

alter function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text)
  rename to place_order_v5_legacy;
revoke execute on function public.place_order_v5_legacy(jsonb, text, date, public.delivery_slot, public.payment_method, text) from public, anon, authenticated;

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
  v_rest public.restaurants;
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Only customer accounts can place orders' using errcode = '42501';
  end if;
  select * into v_rest from public.restaurants where owner_id = (select auth.uid());
  if not found then raise exception 'No customer account is linked to this login'; end if;
  return public.place_order_core(v_rest, (select auth.uid()), p_items, p_notes, p_delivery_date,
                                 p_delivery_slot, p_payment_method, p_po_reference, true);
end;
$$;

-- A staff member (orders:edit, in scope) places an order for a customer.
create function public.place_order_for(
  p_restaurant_id  uuid,
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
  v_rest public.restaurants;
begin
  if not (select public.has_permission('orders', 'edit')) then
    raise exception 'You do not have permission to place orders for customers' using errcode = '42501';
  end if;
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Customer not found'; end if;
  if not (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    raise exception 'That customer is outside your scope' using errcode = '42501';
  end if;
  -- Staff may place past the cut-off (p_enforce_slot = false); the rest of the rules hold.
  return public.place_order_core(v_rest, (select auth.uid()), p_items, p_notes, p_delivery_date,
                                 p_delivery_slot, p_payment_method, p_po_reference, false);
end;
$$;

-- ---------- 4. Edit an order -------------------------------------------------------

-- Customer: their own order while still 'placed' and before the cut-off.
-- Staff (orders:edit, in scope): a 'placed' or 'confirmed' order (before packing).
-- Lines are rebuilt (stock returned and re-reserved) and the order re-totalled.
create function public.edit_order(
  p_order_id       uuid,
  p_items          jsonb,
  p_notes          text default null,
  p_delivery_date  date default null,
  p_delivery_slot  public.delivery_slot default null,
  p_po_reference   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_role   public.user_role := (select public.app_role());
  v_order  public.orders;
  v_rest   public.restaurants;
  v_sector public.sectors;
  v_is_staff boolean := false;
  v_mov    numeric(12,2);
  v_fee    numeric(12,2);
  v_feecalc jsonb;
  v_lines  jsonb;
  v_subtotal numeric(12,2);
  v_tax    numeric(12,2);
  v_total  numeric(12,2);
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_slotchk jsonb;
  v_slot   public.delivery_slot;
  v_date   date;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  select * into v_rest from public.restaurants where id = v_order.restaurant_id;

  if v_role = 'restaurant' and v_order.restaurant_id = (select public.my_restaurant_id()) then
    if v_order.status <> 'placed' then raise exception 'Only a placed order can be changed (this one is %)', v_order.status; end if;
    v_slotchk := public.slot_open(v_order.city_id, v_order.delivery_date, v_order.delivery_slot);
    if not (v_slotchk ->> 'open')::boolean then raise exception 'The cut-off for this order has passed, so it can no longer be changed.'; end if;
  elsif (select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_order.city_id, v_order.warehouse_id)) then
    v_is_staff := true;
    if v_order.status not in ('placed', 'confirmed') then
      raise exception 'An order can be edited until it is packed (this one is %)', v_order.status;
    end if;
  else
    raise exception 'You cannot edit this order' using errcode = '42501';
  end if;

  v_slot := coalesce(p_delivery_slot, v_order.delivery_slot);
  v_date := coalesce(p_delivery_date, v_order.delivery_date);
  if v_slot = 'express' then v_date := v_today;
  elsif v_date < v_today + 1 then raise exception 'Scheduled deliveries start from tomorrow';
  elsif v_date > v_today + 7 then raise exception 'Delivery date must be within the next 7 days'; end if;

  select * into v_sector from public.sectors where code = v_order.sector_code;
  v_mov := coalesce(v_rest.min_order_value, v_sector.min_order_value, 0);
  if v_sector.needs_po_reference and length(trim(coalesce(coalesce(p_po_reference, v_order.po_reference), ''))) = 0 then
    raise exception 'A purchase order / indent number is required for % orders', v_sector.name;
  end if;

  v_lines := public.rebuild_order_lines(p_order_id, v_rest, p_items);
  v_subtotal := (v_lines ->> 'subtotal')::numeric;
  v_tax := (v_lines ->> 'tax')::numeric;
  v_feecalc := public.delivery_fee_for(v_order.city_id, v_slot, v_subtotal, v_mov,
                                       coalesce(v_rest.delivery_fee_below_mov, v_sector.delivery_fee_below_mov, 0));
  v_fee := (v_feecalc ->> 'fee')::numeric;
  if v_subtotal < v_mov and v_fee <= 0 then
    raise exception 'Minimum order value is %. Add % more.', v_mov, v_mov - v_subtotal;
  end if;

  v_total := v_subtotal + v_tax + v_fee;
  update public.orders
  set subtotal = v_subtotal, tax_amount = v_tax, delivery_fee = v_fee, total_amount = v_total,
      notes = coalesce(left(p_notes, 500), notes),
      delivery_date = v_date, delivery_slot = v_slot,
      po_reference = coalesce(left(nullif(trim(p_po_reference), ''), 60), po_reference)
  where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, v_order.status, v_uid, case when v_is_staff then 'Edited by staff' else 'Edited by customer' end);

  return jsonb_build_object('id', p_order_id, 'order_number', v_order.order_number, 'total_amount', v_total, 'delivery_fee', v_fee);
end;
$$;

-- ---------- 5. Cancellation with the cut-off rule ---------------------------------

-- Customer: own 'placed' order before its cut-off. Staff (orders:edit, scope):
-- any order not yet delivered or cancelled. Stock goes back either way.
create function public.cancel_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_role  public.user_role := (select public.app_role());
  v_order public.orders;
  v_item  record;
  v_slotchk jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;

  if v_role = 'restaurant' and v_order.restaurant_id = (select public.my_restaurant_id()) then
    if v_order.status <> 'placed' then raise exception 'Only a placed order can be cancelled by you (this one is %)', v_order.status; end if;
    v_slotchk := public.slot_open(v_order.city_id, v_order.delivery_date, v_order.delivery_slot);
    if not (v_slotchk ->> 'open')::boolean then raise exception 'The cut-off has passed; contact us to cancel this order.'; end if;
  elsif (select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_order.city_id, v_order.warehouse_id)) then
    if v_order.status in ('delivered', 'cancelled') then raise exception 'This order is already %', v_order.status; end if;
  else
    raise exception 'You cannot cancel this order' using errcode = '42501';
  end if;

  update public.orders set status = 'cancelled' where id = p_order_id;
  for v_item in select product_id, quantity from public.order_items where order_id = p_order_id loop
    perform public.apply_stock_movement(v_order.warehouse_id, v_item.product_id, v_item.quantity, 'order_cancelled',
                                        null, p_order_id, null, v_order.order_number);
  end loop;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, 'cancelled', v_uid, left(p_reason, 300));
end;
$$;

-- ---------- 6. Report an issue → credit note --------------------------------------

create sequence public.credit_note_number_seq start 1000;

create table public.order_issues (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  kind          text not null check (kind in ('quality', 'short', 'damaged', 'wrong_item', 'other')),
  note          text,
  status        text not null default 'open' check (status in ('open', 'resolved', 'rejected')),
  resolution    text,
  raised_by     uuid references public.profiles (id) on delete set null,
  resolved_by   uuid references public.profiles (id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index order_issues_order_idx on public.order_issues (order_id);
create index order_issues_status_idx on public.order_issues (status);

create table public.credit_notes (
  id                 uuid primary key default gen_random_uuid(),
  credit_note_number text not null unique default ('CN-' || nextval('public.credit_note_number_seq')::text),
  restaurant_id      uuid not null references public.restaurants (id) on delete restrict,
  order_id           uuid references public.orders (id) on delete set null,
  issue_id           uuid references public.order_issues (id) on delete set null,
  amount             numeric(12,2) not null check (amount > 0),
  reason             text,
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now()
);
create index credit_notes_restaurant_idx on public.credit_notes (restaurant_id);
comment on table public.credit_notes is
  'A credit owed to a customer (from a resolved issue). Applied against the account balance in batch 7 (Payments & credit).';

-- A customer (or staff) reports a problem with one of the customer's orders.
create function public.report_issue(p_order_id uuid, p_kind text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_role  public.user_role := (select public.app_role());
  v_order public.orders;
  v_id    uuid;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  if v_role = 'restaurant' then
    if v_order.restaurant_id <> (select public.my_restaurant_id()) then
      raise exception 'That is not your order' using errcode = '42501';
    end if;
  elsif not ((select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_order.city_id, v_order.warehouse_id))) then
    raise exception 'You cannot report an issue on this order' using errcode = '42501';
  end if;
  if p_kind not in ('quality', 'short', 'damaged', 'wrong_item', 'other') then
    raise exception 'Choose a valid issue type';
  end if;

  insert into public.order_issues (order_id, restaurant_id, kind, note, raised_by)
  values (p_order_id, v_order.restaurant_id, p_kind, left(p_note, 1000), v_uid)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- Support resolves an issue (orders:edit, in scope). A credit amount > 0 raises
-- a credit note; p_reject = true closes it with no credit.
create function public.resolve_issue(p_issue_id uuid, p_resolution text, p_credit_amount numeric default 0, p_reject boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_issue public.order_issues;
  v_order public.orders;
  v_cn    text;
begin
  select * into v_issue from public.order_issues where id = p_issue_id for update;
  if not found then raise exception 'Issue not found'; end if;
  select * into v_order from public.orders where id = v_issue.order_id;
  if not ((select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_order.city_id, v_order.warehouse_id))) then
    raise exception 'You do not have permission to resolve this issue' using errcode = '42501';
  end if;
  if v_issue.status <> 'open' then raise exception 'This issue is already %', v_issue.status; end if;

  if p_reject then
    update public.order_issues set status = 'rejected', resolution = left(p_resolution, 1000), resolved_by = v_uid, resolved_at = now() where id = p_issue_id;
    return jsonb_build_object('status', 'rejected');
  end if;

  update public.order_issues set status = 'resolved', resolution = left(p_resolution, 1000), resolved_by = v_uid, resolved_at = now() where id = p_issue_id;

  if coalesce(p_credit_amount, 0) > 0 then
    if p_credit_amount > v_order.total_amount then
      raise exception 'A credit note cannot be more than the order total (%)', v_order.total_amount;
    end if;
    insert into public.credit_notes (restaurant_id, order_id, issue_id, amount, reason, created_by)
    values (v_issue.restaurant_id, v_issue.order_id, p_issue_id, p_credit_amount, left(p_resolution, 300), v_uid)
    returning credit_note_number into v_cn;
    return jsonb_build_object('status', 'resolved', 'credit_note', v_cn, 'amount', p_credit_amount);
  end if;
  return jsonb_build_object('status', 'resolved');
end;
$$;

-- ---------- 7. Audit --------------------------------------------------------------

create trigger audit_slot_config   after insert or update or delete on public.slot_config   for each row execute function public.write_audit_log();
create trigger audit_order_issues  after insert or update or delete on public.order_issues  for each row execute function public.write_audit_log();
create trigger audit_credit_notes  after insert or update or delete on public.credit_notes  for each row execute function public.write_audit_log();

-- ---------- 8. Row Level Security and grants --------------------------------------

alter table public.slot_config   enable row level security;
alter table public.order_issues  enable row level security;
alter table public.credit_notes  enable row level security;
revoke all on public.slot_config, public.order_issues, public.credit_notes from anon;

-- Slot config: any signed-in user may read (the customer app shows cut-offs); settings:edit writes.
create policy slot_config_select on public.slot_config for select to authenticated using (true);
create policy slot_config_write  on public.slot_config for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));

-- Issues: the customer sees their own; staff see theirs in scope. Written by functions.
create policy order_issues_select on public.order_issues for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or ((select public.has_permission('orders', 'view'))
             and exists (select 1 from public.orders o where o.id = order_id and (select public.in_my_scope(o.city_id, o.warehouse_id)))));

-- Credit notes: the customer sees their own; finance / payments view the rest.
create policy credit_notes_select on public.credit_notes for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or (select public.has_permission('payments', 'view'))
         or (select public.has_permission('customers', 'view')));

revoke all on public.order_issues, public.credit_notes from authenticated;
grant select on public.order_issues, public.credit_notes to authenticated;

revoke execute on function public.slot_open(uuid, date, public.delivery_slot)             from public, anon;
revoke execute on function public.rebuild_order_lines(uuid, public.restaurants, jsonb)     from public, anon, authenticated;
revoke execute on function public.place_order_core(public.restaurants, uuid, jsonb, text, date, public.delivery_slot, public.payment_method, text, boolean) from public, anon, authenticated;
revoke execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text) from public, anon;
revoke execute on function public.place_order_for(uuid, jsonb, text, date, public.delivery_slot, public.payment_method, text) from public, anon;
revoke execute on function public.edit_order(uuid, jsonb, text, date, public.delivery_slot, text) from public, anon;
revoke execute on function public.cancel_order(uuid, text)                                 from public, anon;
revoke execute on function public.report_issue(uuid, text, text)                           from public, anon;
revoke execute on function public.resolve_issue(uuid, text, numeric, boolean)              from public, anon;
grant execute on function public.slot_open(uuid, date, public.delivery_slot)               to authenticated;
grant execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text) to authenticated;
grant execute on function public.place_order_for(uuid, jsonb, text, date, public.delivery_slot, public.payment_method, text) to authenticated;
grant execute on function public.edit_order(uuid, jsonb, text, date, public.delivery_slot, text) to authenticated;
grant execute on function public.cancel_order(uuid, text)                                  to authenticated;
grant execute on function public.report_issue(uuid, text, text)                            to authenticated;
grant execute on function public.resolve_issue(uuid, text, numeric, boolean)               to authenticated;

-- No slot_config rows are seeded here on purpose: with no row a slot is always
-- open and uncapped, so ordering behaves exactly as before until an admin sets
-- cut-offs under Settings. Sample cut-offs for a fresh install live in seed.sql.
