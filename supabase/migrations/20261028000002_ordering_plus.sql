-- =============================================================================
-- Migration 021: Ordering + (Phase 2, batch P2-2).
--
--   * COUPONS: a code with a % or ₹ discount, minimum order, cap, validity,
--     optional sector and once-per-customer rule. The cart previews it
--     (validate_coupon); place_order applies it after the order core has priced
--     the lines (orders.discount_amount / coupon_code; total = subtotal + GST +
--     fee − discount). Redemptions are kept per order.
--   * STANDING ORDERS: a saved basket that places itself for chosen weekdays
--     (delivered the next day) — run_standing_orders() runs once a day from the
--     scheduler (the send-notifications function calls it) and records
--     success / failure per template. Held for approval like any order.
--   * QUOTES: staff price a basket for a customer (quoted unit prices, validity);
--     the customer accepts it into an order at the quoted prices, or declines.
--   * SPEND REPORT: the customer's own spend by month / product / outlet.
--   * Bulk CSV upload and the public calculators are browser-side (no schema).
--
-- Decision record: docs/adr/0026-ordering-plus.md
-- =============================================================================

-- ---------- 1. Coupons ----------------------------------------------------------------

create table public.coupons (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique check (code ~ '^[A-Z0-9-]{3,20}$'),
  description       text not null default '',
  kind              text not null check (kind in ('percent', 'amount')),
  value             numeric(12,2) not null check (value > 0),
  min_order_value   numeric(12,2) not null default 0 check (min_order_value >= 0),
  max_discount      numeric(12,2) check (max_discount is null or max_discount > 0),   -- cap for percent coupons
  valid_from        date not null default (now() at time zone 'Asia/Kolkata')::date,
  valid_to          date,
  sector_code       text references public.sectors (code) on delete set null,          -- null = every sector
  once_per_customer boolean not null default true,
  max_uses          integer check (max_uses is null or max_uses > 0),
  uses              integer not null default 0,
  is_active         boolean not null default true,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger coupons_set_updated_at before update on public.coupons for each row execute function public.set_updated_at();
comment on table public.coupons is 'Discount codes (Settings → Coupons). percent: value = %, capped by max_discount; amount: value = ₹ off. Applied on the subtotal before GST.';

create table public.coupon_redemptions (
  id            uuid primary key default gen_random_uuid(),
  coupon_id     uuid not null references public.coupons (id) on delete cascade,
  order_id      uuid not null unique references public.orders (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  discount      numeric(12,2) not null check (discount >= 0),
  created_at    timestamptz not null default now()
);
create index coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id, restaurant_id);

alter table public.orders
  add column coupon_code     text,
  add column discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0);

-- Is this code usable by this customer for a subtotal? Returns {valid, discount, reason, code}.
-- Internal arithmetic shared by the preview and by place_order.
create function public.coupon_check(p_code text, p_restaurant_id uuid, p_subtotal numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c     public.coupons;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_disc  numeric(12,2);
  v_sector text;
begin
  if nullif(trim(coalesce(p_code, '')), '') is null then return jsonb_build_object('valid', false, 'discount', 0, 'reason', 'Enter a code'); end if;
  select * into v_c from public.coupons where code = upper(trim(p_code));
  if not found or not v_c.is_active then return jsonb_build_object('valid', false, 'discount', 0, 'reason', 'That code is not valid'); end if;
  if v_today < v_c.valid_from or (v_c.valid_to is not null and v_today > v_c.valid_to) then
    return jsonb_build_object('valid', false, 'discount', 0, 'reason', 'That code has expired');
  end if;
  if v_c.max_uses is not null and v_c.uses >= v_c.max_uses then return jsonb_build_object('valid', false, 'discount', 0, 'reason', 'That code has been used up'); end if;
  select sector_code into v_sector from public.restaurants where id = p_restaurant_id;
  if v_c.sector_code is not null and v_c.sector_code is distinct from v_sector then
    return jsonb_build_object('valid', false, 'discount', 0, 'reason', 'That code is for a different kind of customer');
  end if;
  if v_c.once_per_customer and exists (select 1 from public.coupon_redemptions r join public.orders o on o.id = r.order_id
                                       where r.coupon_id = v_c.id and r.restaurant_id = p_restaurant_id and o.status <> 'cancelled' and r.discount > 0) then
    return jsonb_build_object('valid', false, 'discount', 0, 'reason', 'You have already used this code');
  end if;
  if coalesce(p_subtotal, 0) < v_c.min_order_value then
    return jsonb_build_object('valid', false, 'discount', 0, 'reason', 'This code needs an order of at least ₹' || to_char(v_c.min_order_value, 'FM999999990'));
  end if;
  v_disc := case when v_c.kind = 'percent' then round(p_subtotal * v_c.value / 100, 2) else v_c.value end;
  if v_c.max_discount is not null then v_disc := least(v_disc, v_c.max_discount); end if;
  v_disc := least(v_disc, p_subtotal);
  return jsonb_build_object('valid', true, 'discount', v_disc, 'code', v_c.code, 'coupon_id', v_c.id,
                            'label', case when v_c.kind = 'percent' then v_c.value::text || '% off' else '₹' || to_char(v_c.value, 'FM999999990') || ' off' end);
end;
$$;
revoke execute on function public.coupon_check(text, uuid, numeric) from public, anon, authenticated;

-- The cart preview (customer): same answer place_order will give.
create function public.validate_coupon(p_code text, p_subtotal numeric)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.coupon_check(p_code, (select public.my_restaurant_id()), p_subtotal);
$$;
revoke execute on function public.validate_coupon(text, numeric) from public, anon;
grant  execute on function public.validate_coupon(text, numeric) to authenticated;

-- Apply a coupon to a freshly placed order (internal): discount, total, redemption, counter.
create function public.apply_coupon_to_order(p_order_id uuid, p_code text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o   public.orders;
  v_chk jsonb;
begin
  if nullif(trim(coalesce(p_code, '')), '') is null then return 0; end if;
  select * into v_o from public.orders where id = p_order_id for update;
  v_chk := public.coupon_check(p_code, v_o.restaurant_id, v_o.subtotal);
  if not (v_chk ->> 'valid')::boolean then raise exception '%', v_chk ->> 'reason'; end if;
  update public.orders
  set coupon_code = v_chk ->> 'code', discount_amount = (v_chk ->> 'discount')::numeric,
      total_amount = subtotal + tax_amount + delivery_fee - (v_chk ->> 'discount')::numeric
  where id = p_order_id;
  insert into public.coupon_redemptions (coupon_id, order_id, restaurant_id, discount)
  values ((v_chk ->> 'coupon_id')::uuid, p_order_id, v_o.restaurant_id, (v_chk ->> 'discount')::numeric);
  update public.coupons set uses = uses + 1 where id = (v_chk ->> 'coupon_id')::uuid;
  return (v_chk ->> 'discount')::numeric;
end;
$$;
revoke execute on function public.apply_coupon_to_order(uuid, text) from public, anon, authenticated;

-- ---------- 2. place_order v8: coupon ------------------------------------------------------

alter function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid) rename to place_order_v7_legacy;
revoke execute on function public.place_order_v7_legacy(jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid) from public, anon, authenticated;

create function public.place_order(
  p_items          jsonb,
  p_notes          text default null,
  p_delivery_date  date default null,
  p_delivery_slot  public.delivery_slot default 'morning',
  p_payment_method public.payment_method default 'cod',
  p_po_reference   text default null,
  p_outlet_id      uuid default null,
  p_coupon_code    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_disc   numeric := 0;
begin
  v_result := public.place_order_v7_legacy(p_items, p_notes, p_delivery_date, p_delivery_slot, p_payment_method, p_po_reference, p_outlet_id);
  if nullif(trim(coalesce(p_coupon_code, '')), '') is not null then
    v_disc := public.apply_coupon_to_order((v_result ->> 'id')::uuid, p_coupon_code);
    v_result := v_result || jsonb_build_object('discount_amount', v_disc, 'total_amount', (select total_amount from public.orders where id = (v_result ->> 'id')::uuid));
  end if;
  return v_result;
end;
$$;
revoke execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid, text) from public, anon;
grant  execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text, uuid, text) to authenticated;

-- edit_order v3: keep the discount when a customer / staff member edits the lines (re-checked on the new subtotal).
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
  v_outlet public.outlets;
  v_sector public.sectors;
  v_is_staff boolean := false;
  v_mov    numeric(12,2);
  v_fee    numeric(12,2);
  v_feecalc jsonb;
  v_lines  jsonb;
  v_subtotal numeric(12,2);
  v_tax    numeric(12,2);
  v_total  numeric(12,2);
  v_disc   numeric(12,2) := 0;
  v_chk    jsonb;
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
  select * into v_outlet from public.outlets where id = v_order.outlet_id;
  if found then v_rest := public.restaurant_for_outlet(v_rest, v_outlet); end if;   -- 021: price / stock from the order's outlet
  select * into v_sector from public.sectors where code = v_order.sector_code;

  if v_role = 'restaurant' and v_order.restaurant_id = (select public.my_restaurant_id()) then
    if v_order.status <> 'placed' then raise exception 'Only a placed order can be changed (this one is %)', v_order.status; end if;
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
  -- 021: a coupon stays on the order if it still qualifies on the new subtotal; otherwise it drops off.
  if v_order.coupon_code is not null then
    v_chk := public.coupon_check(v_order.coupon_code, v_order.restaurant_id, v_subtotal);
    -- once_per_customer sees this order's own redemption; treat "already used" as still valid.
    if (v_chk ->> 'valid')::boolean or (v_chk ->> 'reason') = 'You have already used this code' then
      v_disc := case when (v_chk ->> 'valid')::boolean then (v_chk ->> 'discount')::numeric
                     else least(v_order.discount_amount, v_subtotal) end;
      update public.coupon_redemptions set discount = v_disc where order_id = p_order_id;
    else
      v_disc := 0;
      update public.coupon_redemptions set discount = 0 where order_id = p_order_id;   -- kept as history; no longer counts as a use
    end if;
  end if;

  v_total := v_subtotal + v_tax + v_fee - v_disc;
  update public.orders
  set subtotal = v_subtotal, tax_amount = v_tax, delivery_fee = v_fee, discount_amount = v_disc,
      coupon_code = case when v_disc > 0 then coupon_code else null end, total_amount = v_total,
      notes = coalesce(left(p_notes, 500), notes),
      delivery_date = v_date, delivery_slot = v_slot,
      po_reference = coalesce(left(nullif(trim(p_po_reference), ''), 60), po_reference)
  where id = p_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, v_order.status, v_uid, case when v_is_staff then 'Edited by staff' else 'Edited by customer' end);

  return jsonb_build_object('id', p_order_id, 'order_number', v_order.order_number, 'total_amount', v_total, 'delivery_fee', v_fee, 'discount_amount', v_disc);
end;
$$;

-- ---------- 3. Standing orders --------------------------------------------------------------

create table public.standing_orders (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  outlet_id      uuid references public.outlets (id) on delete set null,
  name           text not null check (length(trim(name)) > 0),
  items          jsonb not null,                                         -- [{product_id, quantity}]
  days_of_week   integer[] not null check (array_length(days_of_week, 1) >= 1),   -- 0 = Sunday … 6 = Saturday: the DELIVERY days
  delivery_slot  public.delivery_slot not null default 'morning',
  payment_method public.payment_method not null default 'cod',
  po_reference   text,
  notes          text,
  is_active      boolean not null default true,
  created_by     uuid references public.profiles (id) on delete set null,
  last_run_date  date,                                                   -- the delivery date last placed for
  last_run_at    timestamptz,
  last_order_id  uuid references public.orders (id) on delete set null,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index standing_orders_restaurant_idx on public.standing_orders (restaurant_id, is_active);
create trigger standing_orders_set_updated_at before update on public.standing_orders for each row execute function public.set_updated_at();
comment on table public.standing_orders is 'Baskets that place themselves: run_standing_orders() places tomorrow''s deliveries once a day (the scheduler calls it through send-notifications).';

-- Owner / approver / outlet manager (own outlet) saves a template. Returns the id.
create function public.save_standing_order(
  p_id uuid, p_name text, p_items jsonb, p_days integer[], p_slot public.delivery_slot default 'morning',
  p_payment_method public.payment_method default 'cod', p_outlet_id uuid default null, p_po_reference text default null,
  p_notes text default null, p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rid   uuid := (select public.my_restaurant_id());
  v_scope uuid := (select public.my_outlet_id());
  v_out   uuid;
  v_id    uuid := p_id;
begin
  if (select public.app_role()) is distinct from 'restaurant' or v_rid is null then raise exception 'Customer accounts only' using errcode = '42501'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one product'; end if;
  if p_days is null or array_length(p_days, 1) is null or exists (select 1 from unnest(p_days) d where d < 0 or d > 6) then raise exception 'Choose at least one weekday'; end if;
  if p_slot = 'express' then raise exception 'Standing orders use a scheduled slot, not express'; end if;
  v_out := coalesce(p_outlet_id, v_scope, (select id from public.outlets where restaurant_id = v_rid and is_primary));
  if not exists (select 1 from public.outlets where id = v_out and restaurant_id = v_rid) then raise exception 'Choose one of your outlets'; end if;
  if v_scope is not null and v_out <> v_scope then raise exception 'You can only set up standing orders for your own outlet' using errcode = '42501'; end if;
  if v_id is null then
    insert into public.standing_orders (restaurant_id, outlet_id, name, items, days_of_week, delivery_slot, payment_method, po_reference, notes, is_active, created_by)
    values (v_rid, v_out, left(trim(p_name), 120), p_items, (select array_agg(distinct d order by d) from unnest(p_days) d), p_slot, p_payment_method, left(nullif(trim(p_po_reference), ''), 60), left(p_notes, 500), coalesce(p_is_active, true), (select auth.uid()))
    returning id into v_id;
  else
    update public.standing_orders
    set outlet_id = v_out, name = left(trim(p_name), 120), items = p_items, days_of_week = (select array_agg(distinct d order by d) from unnest(p_days) d),
        delivery_slot = p_slot, payment_method = p_payment_method, po_reference = left(nullif(trim(p_po_reference), ''), 60), notes = left(p_notes, 500),
        is_active = coalesce(p_is_active, is_active), last_error = null
    where id = v_id and restaurant_id = v_rid and (v_scope is null or outlet_id = v_scope);
    if not found then raise exception 'Standing order not found'; end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.save_standing_order(uuid, text, jsonb, integer[], public.delivery_slot, public.payment_method, uuid, text, text, boolean) from public, anon;
grant  execute on function public.save_standing_order(uuid, text, jsonb, integer[], public.delivery_slot, public.payment_method, uuid, text, text, boolean) to authenticated;

-- Pause / resume (customer, own; or staff orders:edit in scope).
create function public.set_standing_order_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_s public.standing_orders; v_r public.restaurants;
begin
  select * into v_s from public.standing_orders where id = p_id;
  if not found then raise exception 'Standing order not found'; end if;
  select * into v_r from public.restaurants where id = v_s.restaurant_id;
  if not (v_s.restaurant_id = (select public.my_restaurant_id())
          or ((select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_r.city_id, v_r.warehouse_id)))) then
    raise exception 'You cannot change this standing order' using errcode = '42501';
  end if;
  update public.standing_orders set is_active = p_active, last_error = null where id = p_id;
end;
$$;
revoke execute on function public.set_standing_order_active(uuid, boolean) from public, anon;
grant  execute on function public.set_standing_order_active(uuid, boolean) to authenticated;

-- Place one template for a delivery date, as its creator (internal; no auth.uid()).
create function public.place_standing_order(p_id uuid, p_delivery_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s      public.standing_orders;
  v_rest   public.restaurants;
  v_outlet public.outlets;
  v_cu     public.customer_users;
  v_result jsonb;
  v_hold   boolean;
begin
  select * into v_s from public.standing_orders where id = p_id for update;
  select * into v_rest from public.restaurants where id = v_s.restaurant_id;
  select * into v_outlet from public.outlets where id = coalesce(v_s.outlet_id, (select id from public.outlets where restaurant_id = v_s.restaurant_id and is_primary));
  if not found or not v_outlet.is_active then raise exception 'The outlet is switched off'; end if;
  v_result := public.place_order_core(public.restaurant_for_outlet(v_rest, v_outlet), v_s.created_by, v_s.items, coalesce(v_s.notes, '') || ' (standing order: ' || v_s.name || ')',
                                      p_delivery_date, v_s.delivery_slot, v_s.payment_method, v_s.po_reference, false);
  select * into v_cu from public.customer_users where user_id = v_s.created_by;
  v_hold := public.customer_needs_approval(v_s.restaurant_id) and coalesce(v_cu.role, 'owner') = 'outlet_manager';
  update public.orders set outlet_id = v_outlet.id, approval_status = case when v_hold then 'pending' else 'not_required' end
  where id = (v_result ->> 'id')::uuid;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values ((v_result ->> 'id')::uuid, 'placed', 'placed', v_s.created_by, 'Placed automatically from standing order "' || v_s.name || '"' || case when v_hold then ' — awaiting approval' else '' end);
  return v_result;
end;
$$;
revoke execute on function public.place_standing_order(uuid, date) from public, anon, authenticated;

-- Once a day: place every active template whose weekday is tomorrow. Idempotent per date.
create function public.run_standing_orders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tomorrow date := (now() at time zone 'Asia/Kolkata')::date + 1;
  v_dow      integer := extract(dow from (now() at time zone 'Asia/Kolkata')::date + 1)::int;
  v_s        record;
  v_ok       integer := 0;
  v_failed   integer := 0;
  v_result   jsonb;
begin
  for v_s in select id from public.standing_orders where is_active and v_dow = any(days_of_week) and (last_run_date is null or last_run_date < v_tomorrow) order by created_at loop
    begin
      v_result := public.place_standing_order(v_s.id, v_tomorrow);
      update public.standing_orders set last_run_date = v_tomorrow, last_run_at = now(), last_order_id = (v_result ->> 'id')::uuid, last_error = null where id = v_s.id;
      v_ok := v_ok + 1;
    exception when others then
      update public.standing_orders set last_run_date = v_tomorrow, last_run_at = now(), last_error = left(sqlerrm, 300) where id = v_s.id;
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('delivery_date', v_tomorrow, 'placed', v_ok, 'failed', v_failed);
end;
$$;
revoke execute on function public.run_standing_orders() from public, anon, authenticated;
grant  execute on function public.run_standing_orders() to service_role;

-- ---------- 4. Quotes ------------------------------------------------------------------------

create sequence public.quote_number_seq start 1000;
create table public.quotes (
  id                uuid primary key default gen_random_uuid(),
  quote_number      text not null unique default ('QT-' || nextval('public.quote_number_seq')::text),
  restaurant_id     uuid not null references public.restaurants (id) on delete cascade,
  outlet_id         uuid references public.outlets (id) on delete set null,
  items             jsonb not null,                                       -- [{product_id, product_name, unit, unit_price, quantity, gst_rate}]
  notes             text,
  valid_until       date not null,
  status            text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  subtotal          numeric(12,2) not null default 0,
  tax_amount        numeric(12,2) not null default 0,
  total_amount      numeric(12,2) not null default 0,
  accepted_order_id uuid references public.orders (id) on delete set null,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index quotes_restaurant_idx on public.quotes (restaurant_id, status, created_at desc);
create trigger quotes_set_updated_at before update on public.quotes for each row execute function public.set_updated_at();

-- Staff (orders:edit, in scope) create / edit a quote; p_items carry the quoted unit prices.
create function public.save_quote(p_id uuid, p_restaurant_id uuid, p_items jsonb, p_valid_until date, p_notes text default null, p_outlet_id uuid default null, p_send boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest  public.restaurants;
  v_items jsonb := '[]'::jsonb;
  v_e     jsonb;
  v_p     public.products;
  v_qty   numeric;
  v_price numeric;
  v_sub   numeric(12,2) := 0;
  v_tax   numeric(12,2) := 0;
  v_id    uuid := p_id;
  v_num   text;
begin
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Customer not found'; end if;
  if not ((select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id))) then
    raise exception 'You cannot quote for this customer' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one line'; end if;
  if p_valid_until < (now() at time zone 'Asia/Kolkata')::date then raise exception 'The validity date is in the past'; end if;
  for v_e in select * from jsonb_array_elements(p_items) loop
    select * into v_p from public.products where id = (v_e ->> 'product_id')::uuid;
    if not found then raise exception 'Unknown product in the quote'; end if;
    v_qty := (v_e ->> 'quantity')::numeric;
    v_price := coalesce((v_e ->> 'unit_price')::numeric, public.customer_price(v_p.id, p_restaurant_id));
    if v_qty is null or v_qty <= 0 or v_price is null or v_price < 0 then raise exception 'Check the quantity and price for %', v_p.name; end if;
    v_items := v_items || jsonb_build_object('product_id', v_p.id, 'product_name', v_p.name, 'unit', v_p.unit, 'unit_price', round(v_price, 2), 'quantity', v_qty, 'gst_rate', v_p.gst_rate);
    v_sub := v_sub + round(v_price * v_qty, 2);
    v_tax := v_tax + round(v_price * v_qty * v_p.gst_rate / 100, 2);
  end loop;
  if v_id is null then
    insert into public.quotes (restaurant_id, outlet_id, items, notes, valid_until, status, subtotal, tax_amount, total_amount, created_by)
    values (p_restaurant_id, p_outlet_id, v_items, left(p_notes, 1000), p_valid_until, case when p_send then 'sent' else 'draft' end, v_sub, v_tax, v_sub + v_tax, (select auth.uid()))
    returning id, quote_number into v_id, v_num;
  else
    update public.quotes
    set outlet_id = p_outlet_id, items = v_items, notes = left(p_notes, 1000), valid_until = p_valid_until,
        status = case when p_send then 'sent' else status end, subtotal = v_sub, tax_amount = v_tax, total_amount = v_sub + v_tax
    where id = v_id and restaurant_id = p_restaurant_id and status in ('draft', 'sent')
    returning quote_number into v_num;
    if not found then raise exception 'Only a draft or sent quote can be edited'; end if;
  end if;
  return jsonb_build_object('id', v_id, 'quote_number', v_num, 'total_amount', v_sub + v_tax);
end;
$$;
revoke execute on function public.save_quote(uuid, uuid, jsonb, date, text, uuid, boolean) from public, anon;
grant  execute on function public.save_quote(uuid, uuid, jsonb, date, text, uuid, boolean) to authenticated;

-- Staff: send / withdraw (status). The customer declines through decline_quote.
create function public.set_quote_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_q public.quotes; v_r public.restaurants;
begin
  select * into v_q from public.quotes where id = p_id;
  if not found then raise exception 'Quote not found'; end if;
  select * into v_r from public.restaurants where id = v_q.restaurant_id;
  if not ((select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_r.city_id, v_r.warehouse_id))) then
    raise exception 'You cannot change this quote' using errcode = '42501';
  end if;
  if p_status not in ('draft', 'sent', 'expired') or v_q.status in ('accepted', 'declined') then raise exception 'Quote % cannot go to %', v_q.status, p_status; end if;
  update public.quotes set status = p_status where id = p_id;
end;
$$;
revoke execute on function public.set_quote_status(uuid, text) from public, anon;
grant  execute on function public.set_quote_status(uuid, text) to authenticated;

-- Customer: accept a sent quote into an order at the quoted prices.
create function public.accept_quote(p_id uuid, p_delivery_date date default null, p_delivery_slot public.delivery_slot default 'morning', p_payment_method public.payment_method default 'cod', p_po_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q      public.quotes;
  v_rid    uuid := (select public.my_restaurant_id());
  v_rest   public.restaurants;
  v_outlet public.outlets;
  v_items  jsonb;
  v_result jsonb;
  v_e      jsonb;
  v_sub    numeric(12,2);
  v_tax    numeric(12,2);
  v_oid    uuid;
begin
  select * into v_q from public.quotes where id = p_id for update;
  if not found or v_q.restaurant_id is distinct from v_rid then raise exception 'Quote not found' using errcode = '42501'; end if;
  if (select public.my_customer_role()) not in ('owner', 'approver') then raise exception 'Only the account owner or an approver can accept a quote' using errcode = '42501'; end if;
  if v_q.status <> 'sent' then raise exception 'This quote is % and cannot be accepted', v_q.status; end if;
  if v_q.valid_until < (now() at time zone 'Asia/Kolkata')::date then
    update public.quotes set status = 'expired' where id = p_id;
    raise exception 'This quote expired on %', to_char(v_q.valid_until, 'DD Mon');
  end if;
  select * into v_rest from public.restaurants where id = v_rid;
  select * into v_outlet from public.outlets where id = coalesce(v_q.outlet_id, (select id from public.outlets where restaurant_id = v_rid and is_primary));
  select jsonb_agg(jsonb_build_object('product_id', e ->> 'product_id', 'quantity', e ->> 'quantity')) into v_items from jsonb_array_elements(v_q.items) e;

  v_result := public.place_order_core(public.restaurant_for_outlet(v_rest, v_outlet), (select auth.uid()), v_items, 'Quote ' || v_q.quote_number,
                                      p_delivery_date, p_delivery_slot, p_payment_method, p_po_reference, true);
  v_oid := (v_result ->> 'id')::uuid;
  -- Quoted prices win over today's price list.
  for v_e in select * from jsonb_array_elements(v_q.items) loop
    update public.order_items set unit_price = (v_e ->> 'unit_price')::numeric where order_id = v_oid and product_id = (v_e ->> 'product_id')::uuid;
  end loop;
  select coalesce(sum(line_total), 0), coalesce(sum(tax_amount), 0) into v_sub, v_tax from public.order_items where order_id = v_oid;
  update public.orders set outlet_id = v_outlet.id, subtotal = v_sub, tax_amount = v_tax, total_amount = v_sub + v_tax + delivery_fee - discount_amount where id = v_oid;
  update public.quotes set status = 'accepted', accepted_order_id = v_oid where id = p_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (v_oid, 'placed', 'placed', (select auth.uid()), 'Accepted from quote ' || v_q.quote_number || ' at the quoted prices');
  return jsonb_build_object('id', v_oid, 'order_number', v_result ->> 'order_number', 'total_amount', v_sub + v_tax + (select delivery_fee from public.orders where id = v_oid));
end;
$$;
revoke execute on function public.accept_quote(uuid, date, public.delivery_slot, public.payment_method, text) from public, anon;
grant  execute on function public.accept_quote(uuid, date, public.delivery_slot, public.payment_method, text) to authenticated;

create function public.decline_quote(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.quotes set status = 'declined', notes = coalesce(notes, '') || case when nullif(trim(coalesce(p_reason, '')), '') is null then '' else E'\nDeclined: ' || left(p_reason, 300) end
  where id = p_id and restaurant_id = (select public.my_restaurant_id()) and status = 'sent';
  if not found then raise exception 'Quote not found or no longer open'; end if;
end;
$$;
revoke execute on function public.decline_quote(uuid, text) from public, anon;
grant  execute on function public.decline_quote(uuid, text) to authenticated;

-- ---------- 5. Spend report (customer) ----------------------------------------------------

-- p_group_by: 'month' | 'product' | 'outlet'. Non-cancelled orders of my account (an outlet manager: their outlet).
create function public.my_spend_report(p_from date, p_to date, p_group_by text default 'month')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rid   uuid := (select public.my_restaurant_id());
  v_scope uuid := (select public.my_outlet_id());
  v_from  timestamptz := p_from::timestamp at time zone 'Asia/Kolkata';
  v_to    timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';
begin
  if v_rid is null then raise exception 'Customer accounts only' using errcode = '42501'; end if;
  if p_group_by not in ('month', 'product', 'outlet') then raise exception 'Unknown grouping %', p_group_by; end if;
  if p_to < p_from or p_to - p_from > 370 then raise exception 'Choose a range of at most a year'; end if;
  if p_group_by = 'product' then
    return (select coalesce(jsonb_agg(t order by t.total desc), '[]'::jsonb) from (
      select oi.product_id::text as key, oi.product_name as label, count(distinct o.id) as orders, sum(oi.quantity) as quantity, sum(oi.line_total) as total
      from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.restaurant_id = v_rid and o.status <> 'cancelled' and o.created_at >= v_from and o.created_at < v_to and (v_scope is null or o.outlet_id = v_scope)
      group by 1, 2) t);
  end if;
  return (select coalesce(jsonb_agg(t order by t.key), '[]'::jsonb) from (
    select case when p_group_by = 'month' then to_char(o.created_at at time zone 'Asia/Kolkata', 'YYYY-MM') else coalesce(o.outlet_id::text, 'none') end as key,
           case when p_group_by = 'month' then to_char(o.created_at at time zone 'Asia/Kolkata', 'Mon YYYY') else coalesce(p.name, 'Primary outlet') end as label,
           count(*) as orders, null::numeric as quantity, sum(o.total_amount) as total
    from public.orders o left join public.outlets p on p.id = o.outlet_id
    where o.restaurant_id = v_rid and o.status <> 'cancelled' and o.created_at >= v_from and o.created_at < v_to and (v_scope is null or o.outlet_id = v_scope)
    group by 1, 2) t);
end;
$$;
revoke execute on function public.my_spend_report(date, date, text) from public, anon;
grant  execute on function public.my_spend_report(date, date, text) to authenticated;

-- ---------- 6. RLS, grants, audit ---------------------------------------------------------

alter table public.coupons            enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.standing_orders    enable row level security;
alter table public.quotes             enable row level security;
revoke all on public.coupons, public.coupon_redemptions, public.standing_orders, public.quotes from anon;
-- coupons keep the default table privileges (the Coupons screen writes rows directly; the settings:edit policy decides);
-- the other three are read-only from the browser — every write goes through a function.
revoke all on public.coupon_redemptions, public.standing_orders, public.quotes from authenticated;
grant select on public.coupon_redemptions, public.standing_orders, public.quotes to authenticated;

create policy coupons_select on public.coupons for select to authenticated using ((select public.app_role()) = 'admin');
create policy coupons_write  on public.coupons for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));
create policy coupon_redemptions_select on public.coupon_redemptions for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id()) or (select public.has_permission('settings', 'view')) or (select public.has_permission('orders', 'view')));
create policy standing_orders_select on public.standing_orders for select to authenticated
  using ((restaurant_id = (select public.my_restaurant_id()) and ((select public.my_outlet_id()) is null or outlet_id = (select public.my_outlet_id())))
         or ((select public.has_permission('orders', 'view'))
             and exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))));
create policy quotes_select on public.quotes for select to authenticated
  using ((restaurant_id = (select public.my_restaurant_id()) and status <> 'draft')
         or ((select public.has_permission('orders', 'view'))
             and exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))));

create trigger audit_coupons         after insert or update or delete on public.coupons         for each row execute function public.write_audit_log();
create trigger audit_standing_orders after insert or update or delete on public.standing_orders for each row execute function public.write_audit_log();
create trigger audit_quotes          after insert or update or delete on public.quotes          for each row execute function public.write_audit_log();
