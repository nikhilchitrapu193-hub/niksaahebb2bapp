-- =============================================================================
-- Migration 017: Customer edit / cancel window.
--
-- Until now a customer could edit or cancel their own 'placed' order as long as
-- the slot's cut-off had not passed — in practice, hours. In real use that is
-- too long: a cantonment that places an order and realises it was wrong needs
-- 10 minutes, not until the morning cut-off. This migration gives each sector a
-- customer_edit_window_minutes (default 15) during which the customer may still
-- change or cancel their own order; after that the slot stays open to STAFF
-- (orders: edit) until packing, as before. 0 = no self-edit (any mistake is a
-- call to our team). The slot cut-off remains a hard ceiling.
--
-- Set the dial per sector under Settings → Sectors & terms. my_order_terms()
-- returns the window so the customer app shows "X minutes left" and hides the
-- buttons when it is spent. The database re-checks every call.
--
-- Decision record: docs/adr/0021-customer-edit-window.md
-- =============================================================================

alter table public.sectors
  add column customer_edit_window_minutes integer not null default 15
  check (customer_edit_window_minutes between 0 and 1440);
comment on column public.sectors.customer_edit_window_minutes is
  'Minutes after placing within which the customer may still edit or cancel their own order (measured from orders.created_at). 0 = no self-edit; 1440 = one day. Staff edit / cancel is unchanged (until packed). The slot cut-off is still a hard ceiling.';

-- Sensible defaults (admin changes them under Settings → Sectors & terms).
-- Defence (indent approved by an officer) gets 0: changes go through our team,
-- not a quiet self-edit. Institutions get a longer window: bigger orders, more
-- people to check with before realising a line is wrong.
update public.sectors set customer_edit_window_minutes = 0  where code = 'defence';
update public.sectors set customer_edit_window_minutes = 60 where code = 'institution';

-- ---------- edit_order v2: the window ---------------------------------------

create or replace function public.edit_order(
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
  v_window integer;
  v_minutes integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  select * into v_rest from public.restaurants where id = v_order.restaurant_id;
  select * into v_sector from public.sectors where code = v_order.sector_code;

  if v_role = 'restaurant' and v_order.restaurant_id = (select public.my_restaurant_id()) then
    if v_order.status <> 'placed' then raise exception 'Only a placed order can be changed (this one is %)', v_order.status; end if;
    -- 017: the self-edit window. The slot cut-off remains a hard ceiling after.
    v_window := coalesce(v_sector.customer_edit_window_minutes, 15);
    v_minutes := floor(extract(epoch from (now() - v_order.created_at)) / 60)::int;
    if v_window = 0 then
      raise exception 'Changes to a placed order go through our team — please call us.';
    elsif v_minutes > v_window then
      raise exception 'Your %-minute window to change this order has passed; call us to make changes.', v_window;
    end if;
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

-- ---------- cancel_order v2: the window ------------------------------------

create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_role  public.user_role := (select public.app_role());
  v_order public.orders;
  v_sector public.sectors;
  v_window integer;
  v_minutes integer;
  v_item  record;
  v_slotchk jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  select * into v_sector from public.sectors where code = v_order.sector_code;

  if v_role = 'restaurant' and v_order.restaurant_id = (select public.my_restaurant_id()) then
    if v_order.status <> 'placed' then raise exception 'Only a placed order can be cancelled by you (this one is %)', v_order.status; end if;
    v_window := coalesce(v_sector.customer_edit_window_minutes, 15);
    v_minutes := floor(extract(epoch from (now() - v_order.created_at)) / 60)::int;
    if v_window = 0 then
      raise exception 'Cancellations go through our team — please call us.';
    elsif v_minutes > v_window then
      raise exception 'Your %-minute window to cancel this order has passed; call us to cancel it.', v_window;
    end if;
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

-- ---------- my_order_terms v4: carry the window ----------------------------

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
begin
  select * into v_rest from public.restaurants where owner_id = (select auth.uid());
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
    'customer_edit_window_minutes', coalesce(v_sec.customer_edit_window_minutes, 15));
end;
$$;
