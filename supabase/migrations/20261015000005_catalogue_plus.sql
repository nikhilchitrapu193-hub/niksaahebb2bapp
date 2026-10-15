-- =============================================================================
-- Migration 010: Catalogue + (build list section 3 / 4, Phase 1, batch 3).
--
--   * Category tree: categories.parent_id, two levels (Vegetables › Leafy greens).
--     Pricing rules inherit down the tree: product → category → parent → global.
--   * Variants: a pack size is its own product row (own SKU, price, stock,
--     HSN) linked by parent_product_id + variant_label, so orders, stock and
--     pricing need no change. The catalogue shows one card with a pack picker.
--   * Product details: grade, origin, veg / non-veg, shelf life, storage note.
--   * Loose-weight items: sold_by_weight + weight_tolerance_pct. After packing,
--     set_packed_quantities() bills the actual weight (within tolerance) or a
--     short supply, re-totals the order and corrects the stock reservation.
--     order_items keeps ordered_quantity; quantity becomes what was billed.
--   * Price lists: a layer over the published price per city and / or sector
--     (a % adjustment, plus fixed prices per product). customer_price() is what
--     place_order charges; my_price_list() tells the customer app the same.
--
-- Decision record: docs/adr/0014-variants-as-products-price-lists-as-a-layer.md
-- =============================================================================

-- ---------- 1. Category tree ------------------------------------------------

alter table public.categories
  add column parent_id   uuid references public.categories (id) on delete restrict,
  add column description text,
  add column is_active   boolean not null default true;
create index categories_parent_idx on public.categories (parent_id);
comment on column public.categories.parent_id is 'NULL = top level. Two levels only (a sub-category cannot have children).';

-- Rule: two levels, no cycles. A sub-category's parent is a top-level
-- category; a category that has children cannot itself get a parent.
create function public.check_category_tree()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'A category cannot be its own parent';
  end if;
  if exists (select 1 from public.categories p where p.id = new.parent_id and p.parent_id is not null) then
    raise exception 'Only two levels: the parent must be a top-level category';
  end if;
  if exists (select 1 from public.categories c where c.parent_id = new.id) then
    raise exception 'This category has sub-categories, so it must stay at the top level';
  end if;
  return new;
end;
$$;
create trigger categories_check_tree before insert or update of parent_id on public.categories
  for each row execute function public.check_category_tree();

-- "Vegetables › Leafy greens"
create function public.category_path(p_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p.id is null then c.name else p.name || ' › ' || c.name end
  from public.categories c left join public.categories p on p.id = c.parent_id
  where c.id = p_id
$$;

-- Hyperpure-style tree for the sample catalogue: the eight seed categories
-- stay top level and get sub-categories; a few more top-level ones are added.
-- Names are unique, so this is safe to re-run and harmless on a fresh install
-- (seed.sql adds the same eight parents if they are missing).
insert into public.categories (name, sort_order) values
  ('Vegetables', 10), ('Fruits', 20), ('Dairy & Eggs', 30), ('Poultry & Meat', 40),
  ('Grains & Pulses', 50), ('Oils & Spices', 60), ('Packaged Foods', 70), ('Kitchen Essentials', 80),
  ('Bakery & Confectionery', 90), ('Beverages', 100), ('Frozen & Ready to cook', 110),
  ('Sauces & Condiments', 120), ('Packaging & Disposables', 130), ('Cleaning & Hygiene', 140), ('Kitchenware', 150)
on conflict (name) do nothing;

insert into public.categories (name, parent_id, sort_order)
select v.name, p.id, v.sort_order
from (values
  ('Leafy greens', 'Vegetables', 11), ('Root vegetables', 'Vegetables', 12), ('Gourds & beans', 'Vegetables', 13), ('Exotic vegetables', 'Vegetables', 14),
  ('Seasonal fruit', 'Fruits', 21), ('Citrus', 'Fruits', 22), ('Imported fruit', 'Fruits', 23),
  ('Milk & curd', 'Dairy & Eggs', 31), ('Paneer & cheese', 'Dairy & Eggs', 32), ('Butter & ghee', 'Dairy & Eggs', 33), ('Eggs', 'Dairy & Eggs', 34),
  ('Chicken', 'Poultry & Meat', 41), ('Mutton', 'Poultry & Meat', 42), ('Seafood', 'Poultry & Meat', 43),
  ('Rice', 'Grains & Pulses', 51), ('Atta & flours', 'Grains & Pulses', 52), ('Dals & pulses', 'Grains & Pulses', 53),
  ('Cooking oils', 'Oils & Spices', 61), ('Whole spices', 'Oils & Spices', 62), ('Ground spices & masalas', 'Oils & Spices', 63),
  ('Sauces', 'Sauces & Condiments', 121), ('Pickles & chutneys', 'Sauces & Condiments', 122),
  ('Containers & boxes', 'Packaging & Disposables', 131), ('Bags & wraps', 'Packaging & Disposables', 132), ('Cutlery & napkins', 'Packaging & Disposables', 133)
) as v (name, parent, sort_order)
join public.categories p on p.name = v.parent
on conflict (name) do nothing;

-- ---------- 2. Product details, variants, loose weight --------------------------

alter table public.products
  add column grade                text,                                   -- A, B, Premium …
  add column origin               text,                                   -- Madanapalle, Kurnool …
  add column veg_type             text check (veg_type is null or veg_type in ('veg', 'non_veg')),
  add column shelf_life_days      integer check (shelf_life_days is null or shelf_life_days >= 0),
  add column storage_note         text,                                   -- "Keep refrigerated"
  add column parent_product_id    uuid references public.products (id) on delete set null,
  add column variant_label        text,                                   -- "25 kg bag"
  add column sold_by_weight       boolean not null default false,
  add column weight_tolerance_pct numeric(5,2) not null default 10 check (weight_tolerance_pct >= 0 and weight_tolerance_pct <= 100);
create index products_parent_idx on public.products (parent_product_id);
comment on column public.products.parent_product_id is
  'Variants: this row is one pack size of the parent product. Own SKU, price and stock; the catalogue groups them.';
comment on column public.products.sold_by_weight is
  'Ordered in kg, weighed at packing, billed on the actual weight within weight_tolerance_pct (set_packed_quantities).';

-- Rule: one level of variants (a variant cannot have variants).
create function public.check_product_variant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_product_id is null then return new; end if;
  if new.parent_product_id = new.id then raise exception 'A product cannot be a variant of itself'; end if;
  if exists (select 1 from public.products p where p.id = new.parent_product_id and p.parent_product_id is not null) then
    raise exception 'The parent is itself a variant; pick the main product';
  end if;
  if exists (select 1 from public.products c where c.parent_product_id = new.id) then
    raise exception 'This product has variants of its own, so it cannot become one';
  end if;
  return new;
end;
$$;
create trigger products_check_variant before insert or update of parent_product_id on public.products
  for each row execute function public.check_product_variant();

-- Audit the new columns too (one trigger; replaces the 009 list).
create or replace trigger audit_products after insert or delete or update of sku, name, price, market_price, gst_rate, unit,
                                min_order_qty, in_stock, is_active, category_id, brand, low_stock_threshold,
                                hsn_code, pack_size, pack_unit, price_source,
                                grade, origin, veg_type, parent_product_id, variant_label, sold_by_weight, weight_tolerance_pct
                                on public.products for each row execute function public.write_audit_log();
create trigger audit_categories after insert or update or delete on public.categories for each row execute function public.write_audit_log();

-- ---------- 3. Billing on actual weight ----------------------------------------

alter table public.order_items
  add column ordered_quantity numeric(10,2),             -- what the customer asked for; quantity = what was billed
  add column packed_at        timestamptz,
  add column packed_by        uuid references public.profiles (id) on delete set null;
update public.order_items set ordered_quantity = quantity where ordered_quantity is null;
alter table public.order_items alter column ordered_quantity set not null;
comment on column public.order_items.ordered_quantity is 'As ordered. quantity is what was packed and billed (set_packed_quantities).';

-- After packing: record the actual quantity per line (orders:edit, in scope).
-- p_items = [{order_item_id, packed_quantity}]. Rules:
--   * only while the order is confirmed or packed;
--   * loose-weight lines may differ from the order by at most the product's
--     tolerance either way; other lines may only be short (packed <= ordered);
--   * the order is re-totalled (delivery fee as decided at order time) and the
--     stock reservation is corrected by the difference.
create function public.set_packed_quantities(p_order_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_order    public.orders;
  v_line     record;
  v_item     public.order_items;
  v_product  public.products;
  v_subtotal numeric(12,2);
  v_tax      numeric(12,2);
  v_n        int := 0;
begin
  if not (select public.has_permission('orders', 'edit')) then
    raise exception 'You do not have permission to pack orders' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if not (select public.in_my_scope(v_order.city_id, v_order.warehouse_id)) then
    raise exception 'This order is outside your scope' using errcode = '42501';
  end if;
  if v_order.status not in ('confirmed', 'packed') then
    raise exception 'Packed quantities can be entered while the order is confirmed or packed (it is %)', v_order.status;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Nothing to record';
  end if;

  for v_line in
    select (e ->> 'order_item_id')::uuid as item_id, (e ->> 'packed_quantity')::numeric as packed
    from jsonb_array_elements(p_items) as e
  loop
    select * into v_item from public.order_items where id = v_line.item_id and order_id = p_order_id for update;
    if not found then raise exception 'Line % does not belong to this order', v_line.item_id; end if;
    -- A line packed as nothing is an order edit (batch 6), not a weight: keep quantities above zero.
    if v_line.packed is null or v_line.packed <= 0 then raise exception 'Packed quantity for "%" must be more than 0 (remove the line by editing the order)', v_item.product_name; end if;
    select * into v_product from public.products where id = v_item.product_id;

    if v_product.sold_by_weight then
      if abs(v_line.packed - v_item.ordered_quantity) > v_item.ordered_quantity * v_product.weight_tolerance_pct / 100 then
        raise exception 'Packed % % of "%" is more than % %% away from the ordered % %',
          v_line.packed, v_item.unit, v_item.product_name, v_product.weight_tolerance_pct, v_item.ordered_quantity, v_item.unit;
      end if;
    elsif v_line.packed > v_item.ordered_quantity then
      raise exception '"%" is not sold by weight: packed quantity cannot exceed the ordered % %', v_item.product_name, v_item.ordered_quantity, v_item.unit;
    end if;

    if v_line.packed <> v_item.quantity then
      -- Stock: the order reserved `quantity`; move the difference (negative delta = more taken).
      perform public.apply_stock_movement(v_order.warehouse_id, v_item.product_id, v_item.quantity - v_line.packed, 'order',
                                          null, p_order_id, null, 'packed ' || v_line.packed || ' of ' || v_item.ordered_quantity);
      update public.order_items set quantity = v_line.packed, packed_at = now(), packed_by = v_uid where id = v_item.id;
    else
      update public.order_items set packed_at = now(), packed_by = v_uid where id = v_item.id;
    end if;
    v_n := v_n + 1;
  end loop;

  -- Re-total. The delivery fee stays as decided at order time (the customer met or missed the minimum then).
  select coalesce(sum(line_total), 0), coalesce(sum(tax_amount), 0) into v_subtotal, v_tax
  from public.order_items where order_id = p_order_id;
  update public.orders
  set subtotal = v_subtotal, tax_amount = v_tax, total_amount = v_subtotal + v_tax + coalesce(delivery_fee, 0)
  where id = p_order_id;

  return jsonb_build_object('lines', v_n, 'subtotal', v_subtotal, 'total_amount', v_subtotal + v_tax + coalesce(v_order.delivery_fee, 0));
end;
$$;


-- ---------- 4. Price lists: a layer over the published price --------------------

create table public.price_lists (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  city_id        uuid references public.cities (id) on delete cascade,   -- NULL = every city
  sector_code    text references public.sectors (code) on delete cascade, -- NULL = every sector
  adjustment_pct numeric(6,2) not null default 0 check (adjustment_pct between -100 and 500), -- -5 = 5 % below the published price
  is_active      boolean not null default true,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- One list per (city, sector) combination, NULLs included.
create unique index price_lists_scope_idx on public.price_lists (coalesce(city_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(sector_code, ''));
comment on table public.price_lists is
  'Per city and / or sector: a % adjustment over the published price, plus fixed prices per product in price_list_items. The most specific active list wins.';
create trigger price_lists_set_updated_at before update on public.price_lists for each row execute function public.set_updated_at();

create table public.price_list_items (
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  product_id    uuid not null references public.products (id) on delete cascade,
  price         numeric(12,2) not null check (price >= 0),
  note          text,
  primary key (price_list_id, product_id)
);

-- The list that applies to a customer: city + sector match beats sector-only beats city-only.
create function public.price_list_for_restaurant(p_restaurant_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.id
  from public.restaurants r
  join public.price_lists l
    on l.is_active
   and (l.city_id is null or l.city_id = r.city_id)
   and (l.sector_code is null or l.sector_code = r.sector_code)
  where r.id = p_restaurant_id
  order by (l.city_id is not null)::int + (l.sector_code is not null)::int desc,
           (l.sector_code is not null)::int desc
  limit 1
$$;

-- What this customer pays for this product: fixed item price, else published × (1 + adjustment), else published.
create function public.customer_price(p_product_id uuid, p_restaurant_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_list  uuid := public.price_list_for_restaurant(p_restaurant_id);
  v_price numeric;
  v_adj   numeric;
begin
  select price into v_price from public.products where id = p_product_id;
  if v_list is null then return v_price; end if;
  select i.price into v_adj from public.price_list_items i where i.price_list_id = v_list and i.product_id = p_product_id;
  if found then return v_adj; end if;
  select round(v_price * (1 + l.adjustment_pct / 100), 2) into v_price from public.price_lists l where l.id = v_list;
  return v_price;
end;
$$;

-- For the customer app: every product whose price for ME differs from the
-- published one, as [{product_id, price}]. Customers only; empty when no list applies.
create function public.my_price_list()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'price', public.customer_price(p.id, r.id))), '[]'::jsonb)
  from public.restaurants r
  cross join public.products p
  where r.owner_id = (select auth.uid()) and p.is_active
    and public.customer_price(p.id, r.id) <> p.price
$$;

-- ---------- 5. Pricing rules inherit from the parent category ----------------------

create or replace function public.pricing_inputs(p_product_id uuid, p_on date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p      public.products;
  v_c      text;
  v_parent uuid;
  v_o      public.product_pricing;
  v_r      public.pricing_rules;
  v_g      public.pricing_rules;
  v_src_rule text := 'category';
  v_cost   public.v_product_cost;
  v_src    uuid;
  v_bm     public.v_product_benchmark;
  v_kg     numeric;
begin
  select * into v_p from public.products where id = p_product_id;
  if not found then raise exception 'Unknown product %', p_product_id; end if;
  select public.category_path(v_p.category_id), parent_id into v_c, v_parent from public.categories where id = v_p.category_id;
  select * into v_o from public.product_pricing where product_id = p_product_id;
  -- Rule in force: the product's category, else its parent category, else global.
  v_r := public.effective_pricing_rule(v_p.category_id, p_on);
  if v_r.id is null and v_parent is not null then
    v_r := public.effective_pricing_rule(v_parent, p_on);
    v_src_rule := 'parent';
  end if;
  v_g := public.effective_pricing_rule(null, p_on);
  if v_r.id is null then v_r := v_g; v_src_rule := 'global'; end if;
  select * into v_cost from public.v_product_cost where product_id = p_product_id;

  v_kg := case v_p.pack_unit when 'kg' then v_p.pack_size when 'l' then v_p.pack_size
                             when 'g' then v_p.pack_size / 1000 when 'ml' then v_p.pack_size / 1000 end;

  v_src := coalesce(v_o.benchmark_source_id, v_r.benchmark_source_id, v_g.benchmark_source_id);
  select * into v_bm from public.v_product_benchmark b
  where b.product_id = p_product_id and (v_src is null or b.source_id = v_src)
  order by (b.source_id = v_src) desc nulls last, b.price_date desc limit 1;

  return jsonb_build_object(
    'product_id',       v_p.id,
    'sku',              v_p.sku,
    'name',             v_p.name,
    'unit',             v_p.unit,
    'category_id',      v_p.category_id,
    'category_name',    v_c,
    'current_price',    v_p.price,
    'current_market_price', v_p.market_price,
    'price_source',     v_p.price_source,
    'gst_rate',         v_p.gst_rate,
    'weight_kg',        v_kg,
    'rule_source',      v_src_rule,
    'has_override',     v_o.product_id is not null,
    'pricing_mode',     coalesce(v_o.pricing_mode, 'rule'),
    'cost_method',      coalesce(v_o.cost_method, v_r.cost_method, v_g.cost_method, 'weighted_avg_30d'),
    'markup_pct',       coalesce(v_o.markup_pct, v_r.markup_pct, v_g.markup_pct, 0),
    'min_markup_pct',   coalesce(v_o.min_markup_pct, v_r.min_markup_pct, v_g.min_markup_pct, 0),
    'wastage_pct',      coalesce(v_o.wastage_pct, v_r.wastage_pct, v_g.wastage_pct, 0),
    'yield_pct',        coalesce(v_o.yield_pct, 100),
    'handling_per_kg',  coalesce(v_o.handling_per_kg, v_r.handling_per_kg, v_g.handling_per_kg, 0),
    'packing_per_unit', coalesce(v_o.packing_per_unit, v_r.packing_per_unit, v_g.packing_per_unit, 0),
    'transport_per_kg', coalesce(v_o.transport_per_kg, v_r.transport_per_kg, v_g.transport_per_kg, 0),
    'market_fee_pct',   coalesce(v_o.market_fee_pct, v_r.market_fee_pct, v_g.market_fee_pct, 0),
    'other_cost_pct',   coalesce(v_o.other_cost_pct, v_r.other_cost_pct, v_g.other_cost_pct, 0),
    'rounding_step',    coalesce(v_o.rounding_step, v_r.rounding_step, v_g.rounding_step, 1),
    'round_mode',       coalesce(v_o.round_mode, v_r.round_mode, v_g.round_mode, 'nearest'),
    'benchmark_cap_pct', coalesce(v_o.benchmark_cap_pct, v_r.benchmark_cap_pct, v_g.benchmark_cap_pct),
    'guard_mode',       coalesce(v_r.guard_mode, v_g.guard_mode, 'warn'),
    'fixed_margin_amount', v_o.fixed_margin_amount,
    'manual_price',     v_o.manual_price,
    'manual_reason',    v_o.manual_reason,
    'manual_cost',      v_o.manual_cost,
    'supplier_quote',   v_o.supplier_quote,
    'quote_date',       v_o.quote_date,
    'latest_cost',      v_cost.latest_cost,
    'latest_cost_date', v_cost.latest_cost_date,
    'avg_cost_30d',     v_cost.avg_cost_30d,
    'benchmark_price',  v_bm.price,
    'benchmark_date',   v_bm.price_date,
    'benchmark_source', v_bm.source_code,
    'benchmark_source_name', v_bm.source_name,
    'benchmark_age_days', v_bm.age_days
  );
end;
$$;

-- The board's category filter includes the category's sub-categories.
create or replace function public.price_board(p_category_id uuid default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('pricing', 'view')) then
    raise exception 'You do not have permission to view prices' using errcode = '42501';
  end if;
  return query
    select public.price_calc(p.id)
    from public.products p
    where p.is_active
      and (p_category_id is null or p.category_id = p_category_id
           or p.category_id in (select c.id from public.categories c where c.parent_id = p_category_id))
    order by p.name;
end;
$$;

-- ---------- 6. place_order v5: customer price list, ordered quantity ----------------

alter function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text)
  rename to place_order_v4_legacy;
revoke execute on function public.place_order_v4_legacy(jsonb, text, date, public.delivery_slot, public.payment_method, text)
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
  v_item_id   uuid;
  v_calc      jsonb;
  v_price     numeric;
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

    -- The price this customer pays: their price list (city / sector), else the published price.
    v_price := public.customer_price(v_product.id, v_rest.id);

    insert into public.order_items (order_id, product_id, product_name, unit, unit_price, quantity, ordered_quantity, gst_rate, hsn_code)
    values (v_order_id, v_product.id, v_product.name, v_product.unit, v_price, v_line.qty, v_line.qty, v_product.gst_rate, v_product.hsn_code)
    returning id into v_item_id;

    -- Cost snapshot (rule 6: margin reports must never change when rules change).
    v_calc := public.price_calc(v_product.id);
    insert into public.order_line_costs (order_item_id, order_id, product_id, unit_cost, cost_method)
    values (v_item_id, v_order_id, v_product.id, (v_calc ->> 'landed_cost')::numeric, v_calc ->> 'cost_method');

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

-- ---------- 7. Audit rows for price lists ------------------------------------------

create or replace function public.write_audit_log()
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
  -- Most tables have an id. Others are keyed by code, list/product, product_id or the matrix triple.
  v_row_id  text := coalesce(v_row ->> 'id', v_row ->> 'code',
                             case when v_row ? 'price_list_id' then (v_row ->> 'price_list_id') || '/' || (v_row ->> 'product_id') end,
                             v_row ->> 'product_id',
                             concat_ws('/', v_row ->> 'team_role', v_row ->> 'module', v_row ->> 'action'));
begin
  if tg_op = 'UPDATE' then
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
create trigger audit_price_lists      after insert or update or delete on public.price_lists      for each row execute function public.write_audit_log();
create trigger audit_price_list_items after insert or update or delete on public.price_list_items for each row execute function public.write_audit_log();

-- ---------- 8. Row Level Security and grants -------------------------------------------

alter table public.price_lists      enable row level security;
alter table public.price_list_items enable row level security;
revoke all on public.price_lists, public.price_list_items from anon;

create policy price_lists_select on public.price_lists for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy price_lists_write  on public.price_lists for all    to authenticated
  using ((select public.has_permission('pricing', 'edit'))) with check ((select public.has_permission('pricing', 'edit')));
create policy price_list_items_select on public.price_list_items for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy price_list_items_write  on public.price_list_items for all    to authenticated
  using ((select public.has_permission('pricing', 'edit'))) with check ((select public.has_permission('pricing', 'edit')));

revoke execute on function public.check_category_tree()                      from public, anon, authenticated;
revoke execute on function public.check_product_variant()                    from public, anon, authenticated;
revoke execute on function public.price_list_for_restaurant(uuid)            from public, anon, authenticated;
revoke execute on function public.customer_price(uuid, uuid)                 from public, anon, authenticated;
revoke execute on function public.category_path(uuid)                        from public, anon;
revoke execute on function public.my_price_list()                            from public, anon;
revoke execute on function public.set_packed_quantities(uuid, jsonb)         from public, anon;
revoke execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text) from public, anon;
grant execute on function public.category_path(uuid)                         to authenticated;
grant execute on function public.my_price_list()                             to authenticated;
grant execute on function public.set_packed_quantities(uuid, jsonb)          to authenticated;
grant execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text) to authenticated;

-- ---------- 9. Legacy kept --------------------------------------------------------
-- place_order_v3_legacy and place_order_v4_legacy can go in a clean-up migration later.
