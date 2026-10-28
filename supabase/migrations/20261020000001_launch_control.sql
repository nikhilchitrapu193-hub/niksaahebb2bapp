-- =============================================================================
-- Migration 014: Launch control — the "lite mode" switches (Phase 1, batch 7).
--
-- One codebase, one database, three switches an admin flips under
-- Settings → Launch. Nothing is removed; the switches decide what the team
-- sees and what the database enforces:
--
--   * Live sectors — sectors.is_active (already there). A sector that is OFF
--     cannot sign up (handle_new_user, migration 006) and, from now on, cannot
--     ORDER either: place_order_core refuses, and my_order_terms tells the
--     customer app so it can show why. Launch with army cantonments only, then
--     switch restaurants on when ready — one tick, no migration.
--   * Pricing mode — company_settings.pricing_mode: 'simple' = you type a price
--     on the product form (price_source 'manual'); the price board, rules,
--     benchmarks and price lists are hidden in the admin app. 'advanced' = the
--     pricing engine (migration 009) as before. Nothing in the database changes
--     with this switch; it only decides what the admin app shows.
--   * Stock mode — company_settings.stock_mode: 'counted' = the stock ledger
--     (migrations 004/006) as before. 'simple' = no quantities: a product is
--     "in stock" or "out of stock" (products.in_stock) and orders never reserve
--     or return stock. Inventory and Procurement are hidden in the admin app.
--
-- Stock rule that makes the switch safe to flip at any time: an order keeps the
-- mode it was placed in (orders.stock_reserved, set by rebuild_order_lines) and
-- every order-linked movement — reservation, packed-quantity correction,
-- cancellation, doorstep return — honours that flag, not the current mode. So an
-- order only ever returns what it took, whichever mode is on today.
--
-- Decision record: docs/adr/0018-launch-control-lite-mode.md
-- =============================================================================

-- ---------- 1. The switches -----------------------------------------------------

alter table public.company_settings
  add column pricing_mode text not null default 'advanced' check (pricing_mode in ('simple', 'advanced')),
  add column stock_mode   text not null default 'counted'  check (stock_mode in ('simple', 'counted'));
comment on column public.company_settings.pricing_mode is
  'simple = prices are typed on the product form; the pricing engine screens are hidden. advanced = price board, rules, benchmarks, price lists.';
comment on column public.company_settings.stock_mode is
  'counted = the stock ledger reserves and returns quantities per order. simple = only the in-stock flag matters; orders never touch stock.';

-- Did this order reserve stock? Set when its lines are (re)built; every later
-- movement for the order follows it. Existing orders all reserved (counted mode).
alter table public.orders add column stock_reserved boolean not null default true;
comment on column public.orders.stock_reserved is
  'true = the lines reserved warehouse stock (counted mode when placed / last edited); false = placed in simple stock mode, nothing to return.';

-- Read helper for the functions below (no grant: internal).
create function public.stock_mode()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select stock_mode from public.company_settings where id = true), 'counted');
$$;
revoke execute on function public.stock_mode() from public, anon, authenticated;

-- ---------- 2. The ledger only returns what it took ------------------------------

-- Same signature as migration 006; only the rule at the top is new.
create or replace function public.apply_stock_movement(
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
  -- Rule: an order only returns what it took. Every movement tied to an order
  -- (reservation, packed-quantity correction, cancellation, doorstep return)
  -- follows the order's own stock_reserved flag — set when its lines were built
  -- — not today's mode, so flipping the switch never unbalances the ledger.
  if p_reason in ('order', 'order_cancelled', 'returned') and p_order_id is not null
     and not (select o.stock_reserved from public.orders o where o.id = p_order_id) then
    return;
  end if;

  if p_warehouse_id is null then raise exception 'Choose a warehouse'; end if;

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

-- ---------- 3. rebuild_order_lines: no availability check in simple mode -------------

-- Same as migration 013 except the stock-availability check only runs in
-- counted mode. The in_stock flag is checked in both modes: that flag IS the
-- stock control in simple mode.
create or replace function public.rebuild_order_lines(p_order_id uuid, p_restaurant public.restaurants, p_items jsonb)
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
  v_counted   boolean := public.stock_mode() = 'counted';
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order must contain at least one item';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'An order can contain at most 100 lines';
  end if;

  -- Return any stock the current lines hold (a no-op if they never took any), then clear them.
  for v_old in select product_id, quantity from public.order_items where order_id = p_order_id loop
    perform public.apply_stock_movement(p_restaurant.warehouse_id, v_old.product_id, v_old.quantity, 'order_cancelled',
                                        null, p_order_id, null, 'order rebuilt');
  end loop;
  delete from public.order_line_costs where order_id = p_order_id;
  delete from public.order_items where order_id = p_order_id;
  -- From here the order follows today's mode (the old lines were returned under the old flag).
  update public.orders set stock_reserved = v_counted where id = p_order_id;

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

    if v_counted then
      select qty into v_available from public.warehouse_stock
      where warehouse_id = p_restaurant.warehouse_id and product_id = v_product.id for update;
      v_available := coalesce(v_available, 0);
      if v_line.qty > v_available then
        raise exception 'Only % % of "%" available right now', v_available, v_product.unit, v_product.name;
      end if;
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

-- ---------- 4. place_order_core: a sector that is off cannot order ------------------

-- Same as migration 013 plus the sector check (first rule after approval).
create or replace function public.place_order_core(
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
  select * into v_sector from public.sectors where code = p_restaurant.sector_code;
  -- Launch control: a sector switched off under Settings → Launch takes no orders.
  if not v_sector.is_active then
    raise exception 'We are not taking orders from % yet', v_sector.name;
  end if;
  if length(trim(coalesce(p_restaurant.address, ''))) = 0 then
    raise exception 'Add a delivery address before ordering';
  end if;
  if p_restaurant.warehouse_id is null then
    raise exception 'We do not deliver to that area yet';
  end if;

  v_mov := coalesce(p_restaurant.min_order_value, v_sector.min_order_value, 0);

  if v_sector.needs_po_reference and length(trim(coalesce(p_po_reference, ''))) = 0 then
    raise exception 'A purchase order / indent number is required for % orders', v_sector.name;
  end if;

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

-- ---------- 5. my_order_terms tells the customer app about the switches ------------

create or replace function public.my_order_terms()
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
    'sector_code',            s.code,
    'sector_active',          s.is_active,
    'delivers',               r.warehouse_id is not null
  )
  from public.restaurants r
  join public.sectors s on s.code = r.sector_code
  where r.owner_id = (select auth.uid())
$$;

-- ---------- 6. launch_status: what the Launch screen shows -------------------------

-- Per sector: customers (total / approved) and orders in the last 30 days, so the
-- admin can see when a sector has enough customers to switch on. settings:view.
create function public.launch_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('settings', 'view')) then
    raise exception 'You do not have permission to see launch settings' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'pricing_mode', (select pricing_mode from public.company_settings where id = true),
    'stock_mode',   (select stock_mode   from public.company_settings where id = true),
    'products_listed', (select count(*) from public.products where is_active and parent_product_id is null),
    'products_in_stock', (select count(*) from public.products where is_active and in_stock and parent_product_id is null),
    'sectors', (select coalesce(jsonb_agg(jsonb_build_object(
                  'code', s.code, 'name', s.name, 'description', s.description, 'is_active', s.is_active,
                  'can_self_register', s.can_self_register, 'sort_order', s.sort_order,
                  'customers', (select count(*) from public.restaurants r where r.sector_code = s.code),
                  'customers_approved', (select count(*) from public.restaurants r where r.sector_code = s.code and r.status = 'approved'),
                  'customers_pending', (select count(*) from public.restaurants r where r.sector_code = s.code and r.status = 'pending'),
                  'orders_30d', (select count(*) from public.orders o where o.sector_code = s.code and o.created_at >= now() - interval '30 days' and o.status <> 'cancelled')
                ) order by s.sort_order), '[]'::jsonb)
                from public.sectors s)
  );
end;
$$;

-- ---------- 7. Grants -------------------------------------------------------------

revoke execute on function public.launch_status() from public, anon;
grant  execute on function public.launch_status() to authenticated;
-- rebuild_order_lines / place_order_core / my_order_terms keep the grants they had (internal / authenticated).
