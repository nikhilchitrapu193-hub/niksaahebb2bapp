-- =============================================================================
-- Migration 009: pricing engine, part 1 (build list section 4, Phase 1).
--
-- Every selling price now comes from a visible formula instead of a typed
-- number:
--
--   landed cost = (cost + transport/kg + handling/kg + packing/unit)
--                 × (1 + market fee %) × (1 + other costs %)
--                 ÷ (yield %) ÷ (1 − wastage %)
--   price       = landed cost × (1 + markup %), capped at benchmark × (1 + cap %),
--                 rounded to the category's step (₹0.50, ₹1, ₹5 …)
--
-- The variables live in pricing_rules (one row per category + one global row,
-- with effective dates) and can be overridden per product in product_pricing.
-- Costs come from the stock ledger (latest receipt or 30-day weighted
-- average), from today's supplier quote, or are typed in. Benchmarks (Rythu
-- Bazaar board, NECC egg rate, DoCA, METRO shelf, harbour rate) are entered
-- by hand or uploaded as CSV and shown to customers as "market rate".
--
-- One SQL function, compute_price_from(inputs), does the arithmetic. The
-- browser has the same formula in web/js/core/pricing.js for live previews;
-- tests feed both the same numbers. Publishing goes through apply_prices(),
-- which re-computes server-side, applies the margin guard, writes products,
-- and records price_history. Prices can be scheduled for a later time.
--
-- Security: every costing table is admin-only (permission module "pricing")
-- and revoked from anon. products gains only safe columns (HSN, pack size,
-- benchmark label/date). Order lines snapshot their cost in a separate
-- admin-only table so customers never see it.
--
-- Decision record: docs/adr/0013-pricing-engine-rules-and-board.md
-- =============================================================================

-- ---------- 1. Permission module "pricing" ----------------------------------
-- role_permissions.module is a check constraint (migration 006); extend it.

-- A check constraint cannot be edited, only replaced: the old one goes and the
-- same name comes back with one more value (no row is touched).
do $$
begin
  execute 'alter table public.role_permissions drop constraint role_permissions_module_check';
  execute $c$alter table public.role_permissions add constraint role_permissions_module_check
    check (module in ('dashboard', 'orders', 'products', 'inventory', 'customers', 'payments',
                      'team', 'settings', 'audit', 'reports', 'pricing'))$c$;
end $$;

-- Starting ticks. view = see the board / rules / benchmarks; edit = enter
-- benchmarks and change rules; approve = publish prices; export = CSV.
insert into public.role_permissions (team_role, module, action)
select v.role, 'pricing', a.action
from (values
  ('pricing_manager',   'view,edit,approve,export'),
  ('city_manager',      'view,edit,approve,export'),
  ('procurement_buyer', 'view,edit')
) as v (role, actions)
cross join lateral unnest(string_to_array(v.actions, ',')) as a (action)
on conflict do nothing;

-- ---------- 2. HSN codes and pack sizes on products ---------------------------

create table public.hsn_codes (
  code             text primary key check (code ~ '^[0-9]{4,8}$'),
  description      text not null,
  default_gst_rate numeric(4,2) not null default 0 check (default_gst_rate between 0 and 100)
);
comment on table public.hsn_codes is
  'GST classification codes. Rates here are starting values for new products; confirm with your CA.';

-- Common food-supply chapters. Rates are the usual ones for unbranded /
-- pre-packaged goods as of 2026; the admin can edit any row.
insert into public.hsn_codes (code, description, default_gst_rate) values
  ('0701', 'Potatoes, fresh',                           0),
  ('0702', 'Tomatoes, fresh',                           0),
  ('0703', 'Onions, garlic, leeks',                     0),
  ('0704', 'Cabbage, cauliflower, broccoli',            0),
  ('0706', 'Carrots, beetroot, radish',                 0),
  ('0707', 'Cucumbers',                                 0),
  ('0708', 'Peas, beans (fresh)',                       0),
  ('0709', 'Other fresh vegetables (chillies, leafy greens, gourds)', 0),
  ('0803', 'Bananas',                                   0),
  ('0805', 'Citrus fruit (lemon, orange, sweet lime)',  0),
  ('0807', 'Papaya, melons, watermelon',                0),
  ('0808', 'Apples, pears',                             0),
  ('0401', 'Milk, fresh',                               0),
  ('0403', 'Curd, yoghurt, buttermilk (pre-packaged)',  5),
  ('0405', 'Butter, ghee',                             12),
  ('0406', 'Paneer, cheese (pre-packaged)',             5),
  ('0407', 'Eggs in shell',                             0),
  ('0207', 'Poultry meat, fresh or chilled',            0),
  ('0204', 'Mutton / goat meat, fresh or chilled',      0),
  ('0302', 'Fish, fresh',                               0),
  ('0306', 'Prawns, crabs, shellfish',                  0),
  ('1006', 'Rice (pre-packaged)',                       5),
  ('0713', 'Pulses and dals (pre-packaged)',            5),
  ('1101', 'Wheat flour / atta (pre-packaged)',         5),
  ('1507', 'Soya bean oil',                             5),
  ('1512', 'Sunflower oil',                             5),
  ('1701', 'Sugar',                                     5),
  ('0904', 'Chilli, pepper (whole or powder)',          5),
  ('0910', 'Turmeric, ginger, other spices',            5),
  ('2103', 'Sauces, ketchup, mixed condiments',        12),
  ('2106', 'Food preparations n.e.s.',                 18),
  ('3923', 'Plastic packaging, containers',            18),
  ('4819', 'Paper cartons, boxes, bags',               18),
  ('7607', 'Aluminium foil',                           18),
  ('4015', 'Rubber / disposable gloves',               18),
  ('3402', 'Cleaning agents, detergents',              18);

alter table public.products
  add column hsn_code          text references public.hsn_codes (code) on delete set null,
  add column pack_size         numeric(10,3) not null default 1 check (pack_size > 0),
  add column pack_unit         text not null default 'kg' check (pack_unit in ('kg', 'g', 'l', 'ml', 'pc')),
  add column price_source      text not null default 'manual' check (price_source in ('manual', 'rule')),
  add column price_updated_at  timestamptz,
  add column benchmark_label   text,   -- e.g. "Rythu Bazaar MVP · 15 Oct"
  add column benchmark_date    date;
comment on column public.products.pack_size is
  'How much of pack_unit one selling unit holds: 1 kg, 15 l (a tin), 30 pc (a tray). Per-kg costs scale by it.';
comment on column public.products.price_source is
  'manual = typed on the product form; rule = published from the price board (form shows it read-only).';
comment on column public.products.benchmark_label is
  'Source and date of market_price, shown to customers next to the struck-through rate.';

-- ---------- 3. Pricing rules per category, with effective dates --------------

create table public.pricing_rules (
  id                  uuid primary key default gen_random_uuid(),
  category_id         uuid references public.categories (id) on delete cascade, -- NULL = global default
  markup_pct          numeric(6,2) not null default 10 check (markup_pct >= 0 and markup_pct <= 500),
  min_markup_pct      numeric(6,2) not null default 0  check (min_markup_pct >= 0),
  wastage_pct         numeric(5,2) not null default 0  check (wastage_pct >= 0 and wastage_pct < 100),
  handling_per_kg     numeric(8,2) not null default 0  check (handling_per_kg >= 0),
  packing_per_unit    numeric(8,2) not null default 0  check (packing_per_unit >= 0),
  transport_per_kg    numeric(8,2) not null default 0  check (transport_per_kg >= 0),
  market_fee_pct      numeric(5,2) not null default 0  check (market_fee_pct >= 0),
  other_cost_pct      numeric(5,2) not null default 0  check (other_cost_pct >= 0),
  rounding_step       numeric(6,2) not null default 1  check (rounding_step > 0),
  round_mode          text not null default 'nearest' check (round_mode in ('nearest', 'up')),
  benchmark_cap_pct   numeric(5,2) check (benchmark_cap_pct is null or benchmark_cap_pct >= 0), -- NULL = no cap
  benchmark_source_id uuid,                        -- FK added after benchmark_sources exists
  cost_method         text not null default 'weighted_avg_30d'
                      check (cost_method in ('weighted_avg_30d', 'latest', 'quote', 'manual')),
  guard_mode          text not null default 'warn' check (guard_mode in ('warn', 'block')),
  effective_from      date not null default (now() at time zone 'Asia/Kolkata')::date,
  effective_to        date check (effective_to is null or effective_to >= effective_from),
  note                text,
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now(),
  unique (category_id, effective_from)
);
-- Exactly one global row per start date (NULLs are distinct in a unique constraint).
create unique index pricing_rules_global_from_idx on public.pricing_rules (effective_from) where category_id is null;
comment on table public.pricing_rules is
  'The pricing variables per category. A row with category_id NULL is the global default. Old rows are kept; the one in force on a date wins.';
comment on column public.pricing_rules.guard_mode is
  'warn = publishing below cost / minimum markup needs a confirmation; block = refused outright.';
create trigger pricing_rules_set_updated_at before update on public.pricing_rules
  for each row execute function public.set_updated_at();

-- The global default. Category rows are seeded from seed.sql (and below for
-- an existing install) because categories may not exist yet on a fresh one.
insert into public.pricing_rules (category_id, markup_pct, min_markup_pct, wastage_pct, rounding_step, note)
values (null, 10, 3, 2, 1, 'Global default; every category without its own row uses this');

-- ---------- 4. Per-product overrides ----------------------------------------
-- Every column here is optional: NULL means "use the category rule".

create table public.product_pricing (
  product_id          uuid primary key references public.products (id) on delete cascade,
  pricing_mode        text not null default 'rule' check (pricing_mode in ('rule', 'fixed_over_benchmark', 'manual')),
  markup_pct          numeric(6,2) check (markup_pct is null or markup_pct >= 0),
  min_markup_pct      numeric(6,2) check (min_markup_pct is null or min_markup_pct >= 0),
  wastage_pct         numeric(5,2) check (wastage_pct is null or (wastage_pct >= 0 and wastage_pct < 100)),
  yield_pct           numeric(5,2) not null default 100 check (yield_pct > 0 and yield_pct <= 100),
  handling_per_kg     numeric(8,2) check (handling_per_kg is null or handling_per_kg >= 0),
  packing_per_unit    numeric(8,2) check (packing_per_unit is null or packing_per_unit >= 0),
  transport_per_kg    numeric(8,2) check (transport_per_kg is null or transport_per_kg >= 0),
  market_fee_pct      numeric(5,2) check (market_fee_pct is null or market_fee_pct >= 0),
  other_cost_pct      numeric(5,2) check (other_cost_pct is null or other_cost_pct >= 0),
  rounding_step       numeric(6,2) check (rounding_step is null or rounding_step > 0),
  round_mode          text check (round_mode is null or round_mode in ('nearest', 'up')),
  benchmark_cap_pct   numeric(5,2) check (benchmark_cap_pct is null or benchmark_cap_pct >= 0),
  benchmark_source_id uuid,
  fixed_margin_amount numeric(10,2),             -- fixed_over_benchmark: benchmark + this (per selling unit)
  manual_price        numeric(12,2) check (manual_price is null or manual_price >= 0),
  manual_reason       text,
  cost_method         text check (cost_method is null or cost_method in ('weighted_avg_30d', 'latest', 'quote', 'manual')),
  manual_cost         numeric(12,2) check (manual_cost is null or manual_cost >= 0),
  supplier_quote      numeric(12,2) check (supplier_quote is null or supplier_quote >= 0), -- today's buying price
  quote_date          date,
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now()
);
comment on table public.product_pricing is
  'Per-product pricing overrides. yield_pct handles dressing / cleaning loss (chicken ~70%). supplier_quote is today''s buying price.';
create trigger product_pricing_set_updated_at before update on public.product_pricing
  for each row execute function public.set_updated_at();

-- ---------- 5. Benchmarks (market rates) ------------------------------------

create table public.benchmark_sources (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[a-z_]+$'),
  name        text not null,
  kind        text not null default 'manual' check (kind in ('manual', 'csv', 'api')),
  url         text,
  is_active   boolean not null default true,
  sort_order  integer not null default 0
);
comment on table public.benchmark_sources is 'Where market rates come from. kind=api is for the Phase 3 fetcher.';

insert into public.benchmark_sources (code, name, url, sort_order) values
  ('rythu_bazaar', 'Rythu Bazaar board (Visakhapatnam)',       null, 10),
  ('necc',         'NECC egg rate (Visakhapatnam)',            'https://www.e2necc.com', 20),
  ('doca',         'DoCA daily retail prices (Visakhapatnam)', 'https://fcainfoweb.nic.in', 30),
  ('agmarknet',    'Agmarknet mandi prices',                   'https://agmarknet.gov.in', 40),
  ('metro',        'METRO Cash & Carry shelf price',           null, 50),
  ('harbour',      'Fishing harbour rate',                     null, 60),
  ('distributor',  'Distributor / brand trade price',          null, 70);

alter table public.pricing_rules   add constraint pricing_rules_benchmark_source_fk
  foreign key (benchmark_source_id) references public.benchmark_sources (id) on delete set null;
alter table public.product_pricing add constraint product_pricing_benchmark_source_fk
  foreign key (benchmark_source_id) references public.benchmark_sources (id) on delete set null;

create table public.benchmark_prices (
  id          bigint generated always as identity primary key,
  source_id   uuid not null references public.benchmark_sources (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  price_date  date not null,
  price       numeric(12,2) not null check (price >= 0),  -- per selling unit of the product
  market      text,                                         -- e.g. "MVP Colony"
  note        text,
  entered_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (source_id, product_id, price_date)
);
create index benchmark_prices_product_idx on public.benchmark_prices (product_id, price_date desc);
comment on table public.benchmark_prices is
  'One market rate per source, product and day, in the product''s selling unit. Re-entering a day overwrites it.';

-- ---------- 6. Price history and scheduled prices ----------------------------

create table public.price_history (
  id                bigint generated always as identity primary key,
  product_id        uuid not null references public.products (id) on delete cascade,
  old_price         numeric(12,2),
  new_price         numeric(12,2) not null,
  old_market_price  numeric(12,2),
  new_market_price  numeric(12,2),
  cost_used         numeric(12,2),           -- landed cost at the time
  markup_used       numeric(6,2),            -- effective markup % at the time
  benchmark_used    numeric(12,2),
  benchmark_source  text,
  pricing_mode      text,
  rule_snapshot     jsonb,                   -- the merged inputs, so the price can be explained later
  reason            text,
  changed_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now()
);
create index price_history_product_idx on public.price_history (product_id, created_at desc);

create table public.scheduled_prices (
  id                bigint generated always as identity primary key,
  product_id        uuid not null references public.products (id) on delete cascade,
  price             numeric(12,2) not null check (price >= 0),
  market_price      numeric(12,2),
  benchmark_label   text,
  benchmark_date    date,
  price_source      text not null default 'rule',
  cost_used         numeric(12,2),
  markup_used       numeric(6,2),
  benchmark_source  text,
  pricing_mode      text,
  rule_snapshot     jsonb,
  reason            text,
  effective_at      timestamptz not null,
  status            text not null default 'pending' check (status in ('pending', 'applied', 'cancelled')),
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  applied_at        timestamptz
);
create index scheduled_prices_due_idx on public.scheduled_prices (effective_at) where status = 'pending';
comment on table public.scheduled_prices is
  'Prices approved today that go live later. publish_due_prices() applies them (pg_cron every 5 min, and whenever the board opens).';

-- Order lines snapshot their cost here, away from order_items (which the
-- customer can read). Margin reports (Phase 1 batch 9) read this table.
create table public.order_line_costs (
  order_item_id  uuid primary key references public.order_items (id) on delete cascade,
  order_id       uuid not null references public.orders (id) on delete cascade,
  product_id     uuid not null references public.products (id) on delete restrict,
  unit_cost      numeric(12,2),            -- landed cost per unit at order time; NULL = no cost on file
  cost_method    text,
  created_at     timestamptz not null default now()
);
create index order_line_costs_order_idx on public.order_line_costs (order_id);

alter table public.order_items add column hsn_code text;   -- snapshot for the invoice

-- Catalogue display choice (readable by every signed-in user, so no secrets).
alter table public.company_settings add column show_prices_incl_gst boolean not null default false;
comment on column public.company_settings.show_prices_incl_gst is
  'Catalogue shows prices including GST when true. Invoices always show the split.';

-- ---------- 7. Audit trail on the rule tables --------------------------------
-- The generic trigger from migration 006; product_pricing is keyed by product_id.

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
  -- Most tables have an id. Others are keyed by code, product_id or the matrix triple.
  v_row_id  text := coalesce(v_row ->> 'id', v_row ->> 'code', v_row ->> 'product_id',
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

create trigger audit_pricing_rules     after insert or update or delete on public.pricing_rules     for each row execute function public.write_audit_log();
create trigger audit_product_pricing   after insert or update or delete on public.product_pricing   for each row execute function public.write_audit_log();
create trigger audit_benchmark_sources after insert or update or delete on public.benchmark_sources for each row execute function public.write_audit_log();
create trigger audit_hsn_codes         after insert or update or delete on public.hsn_codes         for each row execute function public.write_audit_log();

-- The 006 products trigger lists its columns; replace it with the new list
-- (one trigger, so a publish writes one audit row).
create or replace trigger audit_products after insert or delete or update of sku, name, price, market_price, gst_rate, unit,
                                min_order_qty, in_stock, is_active, category_id, brand, low_stock_threshold,
                                hsn_code, pack_size, pack_unit, price_source
                                on public.products for each row execute function public.write_audit_log();

-- ---------- 8. Cost views -------------------------------------------------------
-- security_invoker: the caller's own RLS applies (stock_movements is staff-only).

-- Ledger order. Rows written in one transaction share created_at; seq says
-- which receipt is the latest.
alter table public.stock_movements add column seq bigint generated always as identity;

create view public.v_product_cost with (security_invoker = true) as
with received as (
  select product_id, qty_delta as qty, unit_cost, created_at, seq
  from public.stock_movements
  where reason = 'received' and unit_cost is not null and qty_delta > 0
),
latest as (
  select distinct on (product_id) product_id, unit_cost as latest_cost, created_at::date as latest_cost_date
  from received order by product_id, created_at desc, seq desc
),
avg30 as (
  select product_id,
         round(sum(qty * unit_cost) / nullif(sum(qty), 0), 2) as avg_cost_30d,
         sum(qty) as received_qty_30d
  from received where created_at >= now() - interval '30 days'
  group by product_id
)
select p.id as product_id, l.latest_cost, l.latest_cost_date, a.avg_cost_30d, a.received_qty_30d
from public.products p
left join latest l on l.product_id = p.id
left join avg30  a on a.product_id = p.id;
comment on view public.v_product_cost is 'Latest receipt cost and 30-day weighted-average cost per product, from the stock ledger.';

-- Latest benchmark per product and source, with its age.
create view public.v_product_benchmark with (security_invoker = true) as
select distinct on (b.product_id, b.source_id)
       b.product_id, b.source_id, s.code as source_code, s.name as source_name,
       b.price, b.price_date, b.market,
       ((now() at time zone 'Asia/Kolkata')::date - b.price_date) as age_days
from public.benchmark_prices b
join public.benchmark_sources s on s.id = b.source_id
order by b.product_id, b.source_id, b.price_date desc;

-- ---------- 9. The formula ---------------------------------------------------

-- The rule in force for a category on a date: the category's own row, else the global row.
create function public.effective_pricing_rule(p_category_id uuid, p_on date default (now() at time zone 'Asia/Kolkata')::date)
returns public.pricing_rules
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.pricing_rules r
  where r.category_id is not distinct from p_category_id
    and r.effective_from <= p_on and (r.effective_to is null or r.effective_to >= p_on)
  order by r.effective_from desc limit 1
$$;

-- Everything the formula needs for one product, merged: product override →
-- category rule → global rule. Also the costs and the benchmark on file.
create function public.pricing_inputs(p_product_id uuid, p_on date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p    public.products;
  v_c    text;
  v_o    public.product_pricing;
  v_r    public.pricing_rules;
  v_g    public.pricing_rules;
  v_cost public.v_product_cost;
  v_src  uuid;
  v_bm   public.v_product_benchmark;
  v_kg   numeric;
begin
  select * into v_p from public.products where id = p_product_id;
  if not found then raise exception 'Unknown product %', p_product_id; end if;
  select name into v_c from public.categories where id = v_p.category_id;
  select * into v_o from public.product_pricing where product_id = p_product_id;
  v_r := public.effective_pricing_rule(v_p.category_id, p_on);
  v_g := public.effective_pricing_rule(null, p_on);
  if v_r.id is null then v_r := v_g; end if;
  select * into v_cost from public.v_product_cost where product_id = p_product_id;

  -- Weight of one selling unit, for the per-kg costs. Pieces have no weight: those costs are skipped.
  v_kg := case v_p.pack_unit when 'kg' then v_p.pack_size when 'l' then v_p.pack_size
                             when 'g' then v_p.pack_size / 1000 when 'ml' then v_p.pack_size / 1000 end;

  -- Preferred benchmark source: product → category → global → whichever is newest.
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
    'rule_source',      case when v_r.category_id is null then 'global' else 'category' end,
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

-- Round to a step: nearest (half up) or always up. Two decimals.
create function public.round_price(p_value numeric, p_step numeric, p_mode text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_value is null then null
              when coalesce(p_step, 0) <= 0 then round(p_value, 2)
              when p_mode = 'up' then round(ceil(p_value / p_step) * p_step, 2)
              else round(round(p_value / p_step) * p_step, 2) end
$$;

-- THE formula. Pure: same inputs, same answer. Mirrored line for line by
-- computePrice() in web/js/core/pricing.js — change both or neither.
--
-- Returns: cost_basis, landed_cost, raw_price, suggested_price, capped,
--          margin_amount, margin_pct (on price), markup_effective_pct (on cost),
--          flags (text[]), pricing_mode.
create function public.compute_price_from(i jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_mode     text    := coalesce(i ->> 'pricing_mode', 'rule');
  v_method   text    := coalesce(i ->> 'cost_method', 'weighted_avg_30d');
  v_kg       numeric := (i ->> 'weight_kg')::numeric;
  v_cost     numeric;
  v_landed   numeric;
  v_raw      numeric;
  v_price    numeric;
  v_bm       numeric := (i ->> 'benchmark_price')::numeric;
  v_cap      numeric := (i ->> 'benchmark_cap_pct')::numeric;
  v_capped   boolean := false;
  v_flags    text[]  := '{}';
  v_margin   numeric;
  v_markup   numeric;
  n          numeric; -- scratch
begin
  -- 1. Cost basis, per selling unit.
  v_cost := case v_method
    when 'manual' then (i ->> 'manual_cost')::numeric
    when 'quote'  then (i ->> 'supplier_quote')::numeric
    when 'latest' then (i ->> 'latest_cost')::numeric
    else coalesce((i ->> 'avg_cost_30d')::numeric, (i ->> 'latest_cost')::numeric)
  end;
  -- A fresh quote is the best cost we have when the ledger is empty.
  if v_cost is null then v_cost := (i ->> 'supplier_quote')::numeric; end if;

  -- 2. Landed cost: add the per-kg and per-unit costs, then the percentage ones,
  --    then divide by what survives (yield) and what is sold (1 − wastage).
  if v_cost is not null then
    v_landed := v_cost
              + coalesce(v_kg, 0) * (coalesce((i ->> 'transport_per_kg')::numeric, 0) + coalesce((i ->> 'handling_per_kg')::numeric, 0))
              + coalesce((i ->> 'packing_per_unit')::numeric, 0);
    v_landed := v_landed * (1 + coalesce((i ->> 'market_fee_pct')::numeric, 0) / 100)
                         * (1 + coalesce((i ->> 'other_cost_pct')::numeric, 0) / 100);
    v_landed := v_landed / (coalesce((i ->> 'yield_pct')::numeric, 100) / 100);
    v_landed := v_landed / (1 - coalesce((i ->> 'wastage_pct')::numeric, 0) / 100);
    v_landed := round(v_landed, 4);
  else
    v_flags := array_append(v_flags, 'no_cost');
  end if;

  -- 3. Raw price by mode.
  if v_mode = 'manual' then
    v_raw := (i ->> 'manual_price')::numeric;
    v_flags := array_append(v_flags, 'manual');
  elsif v_mode = 'fixed_over_benchmark' then
    if v_bm is null then v_flags := array_append(v_flags, 'no_benchmark');
    else v_raw := v_bm + coalesce((i ->> 'fixed_margin_amount')::numeric, 0); end if;
  else
    if v_landed is not null then
      v_raw := v_landed * (1 + coalesce((i ->> 'markup_pct')::numeric, 0) / 100);
    end if;
  end if;

  -- 4. Benchmark cap (not for manual prices: the person chose that number).
  if v_raw is not null and v_mode <> 'manual' and v_bm is not null and v_cap is not null then
    n := v_bm * (1 + v_cap / 100);
    if v_raw > n then v_raw := n; v_capped := true; v_flags := array_append(v_flags, 'capped'); end if;
  end if;

  -- 5. Rounding.
  v_price := public.round_price(v_raw, (i ->> 'rounding_step')::numeric, i ->> 'round_mode');

  -- 6. Margin and the guard flags.
  if v_price is not null and v_landed is not null then
    v_margin := round(v_price - v_landed, 2);
    v_markup := case when v_landed > 0 then round((v_price - v_landed) / v_landed * 100, 2) end;
    if v_price < v_landed then v_flags := array_append(v_flags, 'below_cost');
    elsif v_markup is not null and v_markup < coalesce((i ->> 'min_markup_pct')::numeric, 0) then v_flags := array_append(v_flags, 'below_min_markup');
    end if;
  end if;
  if v_bm is not null and coalesce((i ->> 'benchmark_age_days')::int, 0) > 3 then v_flags := array_append(v_flags, 'stale_benchmark'); end if;
  if (i ->> 'avg_cost_30d') is not null and (i ->> 'latest_cost') is not null
     and (i ->> 'avg_cost_30d')::numeric > 0
     and abs((i ->> 'latest_cost')::numeric - (i ->> 'avg_cost_30d')::numeric) / (i ->> 'avg_cost_30d')::numeric > 0.10 then
    v_flags := array_append(v_flags, 'cost_moved');
  end if;

  return jsonb_build_object(
    'pricing_mode',          v_mode,
    'cost_basis',            v_cost,
    'landed_cost',           round(v_landed, 2),
    'raw_price',             round(v_raw, 4),
    'suggested_price',       v_price,
    'capped',                v_capped,
    'margin_amount',         v_margin,
    'margin_pct',            case when v_price > 0 and v_margin is not null then round(v_margin / v_price * 100, 2) end,
    'markup_effective_pct',  v_markup,
    'flags',                 to_jsonb(v_flags)
  );
end;
$$;

-- Internal: inputs + result in one object. No permission check: the callers
-- (compute_price, price_board, apply_prices, place_order) decide who may see it.
create function public.price_calc(p_product_id uuid, p_on date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_in jsonb := public.pricing_inputs(p_product_id, p_on);
begin
  return v_in || public.compute_price_from(v_in);
end;
$$;

-- What the board shows for one product (pricing:view).
create function public.compute_price(p_product_id uuid, p_on date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('pricing', 'view')) then
    raise exception 'You do not have permission to view prices' using errcode = '42501';
  end if;
  return public.price_calc(p_product_id, p_on);
end;
$$;

-- The daily price board: inputs + result for every active product (pricing:view).
create function public.price_board(p_category_id uuid default null)
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
    where p.is_active and (p_category_id is null or p.category_id = p_category_id)
    order by p.name;
end;
$$;

-- ---------- 10. Publishing -----------------------------------------------------

-- Write one approved price to the product and the history. Internal.
create function public.publish_price(
  p_product_id uuid, p_price numeric, p_market_price numeric, p_label text, p_bm_date date,
  p_source text, p_cost numeric, p_markup numeric, p_bm_source text, p_mode text,
  p_snapshot jsonb, p_reason text, p_by uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.products;
begin
  select * into v_old from public.products where id = p_product_id for update;
  update public.products
  set price = p_price,
      market_price = coalesce(p_market_price, market_price),
      benchmark_label = coalesce(p_label, benchmark_label),
      benchmark_date = coalesce(p_bm_date, benchmark_date),
      price_source = p_source,
      price_updated_at = now()
  where id = p_product_id;
  insert into public.price_history (product_id, old_price, new_price, old_market_price, new_market_price,
                                    cost_used, markup_used, benchmark_used, benchmark_source, pricing_mode,
                                    rule_snapshot, reason, changed_by)
  values (p_product_id, v_old.price, p_price, v_old.market_price, coalesce(p_market_price, v_old.market_price),
          p_cost, p_markup, p_market_price, p_bm_source, p_mode, p_snapshot, p_reason, p_by);
end;
$$;
revoke execute on function public.publish_price(uuid, numeric, numeric, text, date, text, numeric, numeric, text, text, jsonb, text, uuid)
  from public, anon, authenticated;

-- Approve & publish (pricing:approve). p_items = [{product_id, price?}]:
-- no price → the computed suggestion. Margin guard: below cost or below the
-- minimum markup is refused when guard_mode = block, and needs p_force when
-- guard_mode = warn. p_effective_at in the future → scheduled instead.
-- Returns {applied, scheduled}.
create function public.apply_prices(
  p_items        jsonb,
  p_reason       text default null,
  p_effective_at timestamptz default null,
  p_force        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_line     record;
  v_calc     jsonb;
  v_price    numeric;
  v_landed   numeric;
  v_markup   numeric;
  v_label    text;
  v_source   text;
  v_applied  int := 0;
  v_sched    int := 0;
  v_schedule boolean := p_effective_at is not null and p_effective_at > now() + interval '1 minute';
begin
  if not (select public.has_permission('pricing', 'approve')) then
    raise exception 'You do not have permission to publish prices' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one product';
  end if;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id, (e ->> 'price')::numeric as price
    from jsonb_array_elements(p_items) as e
  loop
    v_calc  := public.price_calc(v_line.product_id);
    v_price := coalesce(v_line.price, (v_calc ->> 'suggested_price')::numeric);
    if v_price is null then
      raise exception 'No price for "%": add a cost or a benchmark first', v_calc ->> 'name';
    end if;
    if v_price < 0 then raise exception 'Price cannot be negative'; end if;
    v_landed := (v_calc ->> 'landed_cost')::numeric;
    v_markup := case when v_landed > 0 then round((v_price - v_landed) / v_landed * 100, 2) end;

    -- Margin guard (rule: never sell below cost or under the minimum markup
    -- without someone saying so).
    if v_landed is not null then
      if v_price < v_landed then
        if (v_calc ->> 'guard_mode') = 'block' or not p_force then
          raise exception 'Price % for "%" is below its landed cost %. %', v_price, v_calc ->> 'name', round(v_landed, 2),
            case when (v_calc ->> 'guard_mode') = 'block' then 'Publishing below cost is blocked for this category.' else 'Tick "publish anyway" to confirm.' end;
        end if;
      elsif v_markup < (v_calc ->> 'min_markup_pct')::numeric then
        if (v_calc ->> 'guard_mode') = 'block' or not p_force then
          raise exception 'Price % for "%" gives % markup, under the minimum %. %', v_price, v_calc ->> 'name', v_markup || '%', (v_calc ->> 'min_markup_pct') || '%',
            case when (v_calc ->> 'guard_mode') = 'block' then 'Blocked for this category.' else 'Tick "publish anyway" to confirm.' end;
        end if;
      end if;
    end if;

    v_source := case when (v_calc ->> 'pricing_mode') = 'manual' then 'manual' else 'rule' end;
    v_label  := case when v_calc ->> 'benchmark_price' is not null
                     then (v_calc ->> 'benchmark_source_name') || ' · ' || to_char((v_calc ->> 'benchmark_date')::date, 'DD Mon') end;

    if v_schedule then
      insert into public.scheduled_prices (product_id, price, market_price, benchmark_label, benchmark_date, price_source,
                                           cost_used, markup_used, benchmark_source, pricing_mode, rule_snapshot, reason, effective_at, created_by)
      values (v_line.product_id, v_price, (v_calc ->> 'benchmark_price')::numeric, v_label, (v_calc ->> 'benchmark_date')::date, v_source,
              v_landed, v_markup, v_calc ->> 'benchmark_source', v_calc ->> 'pricing_mode', v_calc - 'name' - 'sku', p_reason, p_effective_at, v_uid);
      v_sched := v_sched + 1;
    else
      perform public.publish_price(v_line.product_id, v_price, (v_calc ->> 'benchmark_price')::numeric, v_label, (v_calc ->> 'benchmark_date')::date,
                                   v_source, v_landed, v_markup, v_calc ->> 'benchmark_source', v_calc ->> 'pricing_mode',
                                   v_calc - 'name' - 'sku', p_reason, v_uid);
      v_applied := v_applied + 1;
    end if;
  end loop;

  return jsonb_build_object('applied', v_applied, 'scheduled', v_sched);
end;
$$;

-- Apply every scheduled price whose time has come. Called by pg_cron (no
-- session user) and by the admin app when the board opens. Customers cannot
-- call it; it does nothing a pricing manager has not already approved.
create function public.publish_due_prices()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.scheduled_prices;
  v_n   int := 0;
begin
  if (select auth.uid()) is not null and (select public.app_role()) is distinct from 'admin' then
    raise exception 'Staff only' using errcode = '42501';
  end if;
  for v_row in
    select * from public.scheduled_prices where status = 'pending' and effective_at <= now()
    order by effective_at, id for update skip locked
  loop
    perform public.publish_price(v_row.product_id, v_row.price, v_row.market_price, v_row.benchmark_label, v_row.benchmark_date,
                                 v_row.price_source, v_row.cost_used, v_row.markup_used, v_row.benchmark_source, v_row.pricing_mode,
                                 v_row.rule_snapshot, coalesce(v_row.reason, 'scheduled'), v_row.created_by);
    update public.scheduled_prices set status = 'applied', applied_at = now() where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create function public.cancel_scheduled_price(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('pricing', 'approve')) then
    raise exception 'You do not have permission to change scheduled prices' using errcode = '42501';
  end if;
  update public.scheduled_prices set status = 'cancelled' where id = p_id and status = 'pending';
  if not found then raise exception 'That scheduled price is no longer pending'; end if;
end;
$$;

-- Every 5 minutes, where pg_cron is available (Supabase: Database → Extensions).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.schedule('publish-due-prices', '*/5 * * * *', 'select public.publish_due_prices()');
      raise notice 'pg_cron job publish-due-prices scheduled';
    exception when others then
      raise notice 'pg_cron not enabled (%): scheduled prices go live when the price board is opened', sqlerrm;
    end;
  else
    raise notice 'pg_cron not installed here: scheduled prices go live when the price board is opened';
  end if;
end $$;

-- ---------- 11. place_order v4: HSN and cost snapshots ---------------------------
-- Same rules as v3 (migration 006) plus: order_items.hsn_code is copied from
-- the product and the landed cost per unit is kept in order_line_costs.

alter function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text)
  rename to place_order_v3_legacy;
revoke execute on function public.place_order_v3_legacy(jsonb, text, date, public.delivery_slot, public.payment_method, text)
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

    insert into public.order_items (order_id, product_id, product_name, unit, unit_price, quantity, gst_rate, hsn_code)
    values (v_order_id, v_product.id, v_product.name, v_product.unit, v_product.price, v_line.qty, v_product.gst_rate, v_product.hsn_code)
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

-- ---------- 12. Row Level Security and grants ---------------------------------

alter table public.hsn_codes          enable row level security;
alter table public.pricing_rules      enable row level security;
alter table public.product_pricing    enable row level security;
alter table public.benchmark_sources  enable row level security;
alter table public.benchmark_prices   enable row level security;
alter table public.price_history      enable row level security;
alter table public.scheduled_prices   enable row level security;
alter table public.order_line_costs   enable row level security;

-- Nothing here is for the logged-out website.
revoke all on public.hsn_codes, public.pricing_rules, public.product_pricing, public.benchmark_sources,
              public.benchmark_prices, public.price_history, public.scheduled_prices, public.order_line_costs,
              public.v_product_cost, public.v_product_benchmark
  from anon;

-- HSN codes: any signed-in user may read (the product form, the invoice); pricing:edit maintains them.
create policy hsn_codes_select on public.hsn_codes for select to authenticated using (true);
create policy hsn_codes_write  on public.hsn_codes for all to authenticated
  using ((select public.has_permission('pricing', 'edit'))) with check ((select public.has_permission('pricing', 'edit')));

-- Rules, overrides, sources, benchmark entries: pricing:view to read, pricing:edit to write.
create policy pricing_rules_select on public.pricing_rules for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy pricing_rules_write  on public.pricing_rules for all    to authenticated
  using ((select public.has_permission('pricing', 'edit'))) with check ((select public.has_permission('pricing', 'edit')));
create policy product_pricing_select on public.product_pricing for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy product_pricing_write  on public.product_pricing for all    to authenticated
  using ((select public.has_permission('pricing', 'edit'))) with check ((select public.has_permission('pricing', 'edit')));
create policy benchmark_sources_select on public.benchmark_sources for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy benchmark_sources_write  on public.benchmark_sources for all    to authenticated
  using ((select public.has_permission('pricing', 'edit'))) with check ((select public.has_permission('pricing', 'edit')));
create policy benchmark_prices_select on public.benchmark_prices for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy benchmark_prices_write  on public.benchmark_prices for all    to authenticated
  using ((select public.has_permission('pricing', 'edit'))) with check ((select public.has_permission('pricing', 'edit')));

-- History, schedule and cost snapshots: read with pricing:view; written only by the functions above.
create policy price_history_select    on public.price_history    for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy scheduled_prices_select on public.scheduled_prices for select to authenticated using ((select public.has_permission('pricing', 'view')));
create policy order_line_costs_select on public.order_line_costs for select to authenticated using ((select public.has_permission('pricing', 'view')));
revoke insert, update, delete, truncate on public.price_history, public.scheduled_prices, public.order_line_costs from authenticated;

-- The person who entered a benchmark is recorded automatically; nobody sets it by hand.
revoke insert (entered_by), update (entered_by) on public.benchmark_prices from authenticated;

-- Functions.
revoke execute on function public.effective_pricing_rule(uuid, date)      from public, anon, authenticated;
revoke execute on function public.pricing_inputs(uuid, date)              from public, anon, authenticated;
revoke execute on function public.price_calc(uuid, date)                  from public, anon, authenticated;
revoke execute on function public.compute_price(uuid, date)               from public, anon;
revoke execute on function public.price_board(uuid)                       from public, anon;
revoke execute on function public.apply_prices(jsonb, text, timestamptz, boolean) from public, anon;
revoke execute on function public.publish_due_prices()                    from public, anon;
revoke execute on function public.cancel_scheduled_price(bigint)          from public, anon;
revoke execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text) from public, anon;
grant execute on function public.compute_price_from(jsonb)                to anon, authenticated; -- pure arithmetic, no data
grant execute on function public.round_price(numeric, numeric, text)      to anon, authenticated;
grant execute on function public.compute_price(uuid, date)                to authenticated;
grant execute on function public.price_board(uuid)                        to authenticated;
grant execute on function public.apply_prices(jsonb, text, timestamptz, boolean) to authenticated;
grant execute on function public.publish_due_prices()                     to authenticated;
grant execute on function public.cancel_scheduled_price(bigint)           to authenticated;
grant execute on function public.place_order(jsonb, text, date, public.delivery_slot, public.payment_method, text) to authenticated;

-- ---------- 13. Backfill for an existing install --------------------------------
-- HSN codes, pack sizes and category rules for the sample catalogue. seed.sql
-- carries the same blocks for a fresh install (categories exist only after it).

update public.products p
set hsn_code = v.hsn, pack_size = v.size, pack_unit = v.pu
from (values
  ('VEG-001', '0702', 1, 'kg'),  ('VEG-002', '0703', 1, 'kg'),  ('VEG-003', '0701', 1, 'kg'),
  ('VEG-004', '0709', 1, 'kg'),  ('VEG-005', '0709', 1, 'kg'),
  ('FRT-001', '0803', 1, 'kg'),  ('FRT-002', '0805', 1, 'kg'),  ('FRT-003', '0807', 1, 'kg'),
  ('DAI-001', '0401', 1, 'l'),   ('DAI-002', '0406', 1, 'kg'),  ('DAI-003', '0403', 1, 'kg'),
  ('DAI-004', '0405', 500, 'g'), ('DAI-005', '0407', 30, 'pc'),
  ('PLT-001', '0207', 1, 'kg'),  ('PLT-002', '0207', 1, 'kg'),  ('MTN-001', '0204', 1, 'kg'),
  ('GRN-001', '1006', 1, 'kg'),  ('GRN-002', '0713', 1, 'kg'),  ('GRN-003', '1101', 1, 'kg'),
  ('OIL-001', '1512', 15, 'l'),  ('SPC-001', '0910', 1, 'kg'),  ('SPC-002', '0904', 1, 'kg'),
  ('PKG-001', '2103', 5, 'kg'),  ('KIT-001', '7607', 1, 'pc'),  ('KIT-002', '4015', 100, 'pc')
) as v (sku, hsn, size, pu)
where p.sku = v.sku and p.hsn_code is null;

-- Starting variables from the Vizag pricing research (docs/modules/pricing.md § Starting values).
insert into public.pricing_rules (category_id, markup_pct, min_markup_pct, wastage_pct, rounding_step, benchmark_cap_pct, benchmark_source_id, note)
select c.id, v.markup, v.min_markup, v.wastage, v.step, v.cap, s.id, 'Starting value from the Vizag pricing research'
from (values
  ('Vegetables',         15, 8, 8,   0.5, 10, 'rythu_bazaar'),
  ('Fruits',             15, 8, 10,  0.5, 10, 'rythu_bazaar'),
  ('Dairy & Eggs',        4, 2, 2,   1,   null, 'distributor'),
  ('Poultry & Meat',     10, 5, 3,   5,   null, 'distributor'),
  ('Grains & Pulses',     5, 2, 0.5, 1,   5,  'doca'),
  ('Oils & Spices',       5, 2, 0.5, 1,   5,  'metro'),
  ('Packaged Foods',      5, 2, 0.5, 1,   5,  'metro'),
  ('Kitchen Essentials',  8, 3, 0,   1,   null, 'metro')
) as v (category, markup, min_markup, wastage, step, cap, source)
join public.categories c on c.name = v.category
left join public.benchmark_sources s on s.code = v.source
on conflict (category_id, effective_from) do nothing;

-- Eggs: NECC rate + ₹0.30 per egg = ₹9 per tray of 30.
insert into public.product_pricing (product_id, pricing_mode, fixed_margin_amount, rounding_step, benchmark_source_id, manual_reason)
select p.id, 'fixed_over_benchmark', 9, 1, s.id, 'NECC rate + ₹0.30 per egg'
from public.products p, public.benchmark_sources s
where p.sku = 'DAI-005' and s.code = 'necc'
on conflict (product_id) do nothing;

-- Chicken: about 70% of live weight is sold after dressing.
insert into public.product_pricing (product_id, yield_pct, manual_reason)
select p.id, 70, 'Dressing yield; confirm with the supplier'
from public.products p where p.sku in ('PLT-001', 'PLT-002')
on conflict (product_id) do nothing;

-- ---------- 14. Legacy functions kept (house rule: no DROP in migrations) --------
-- place_order_v3_legacy can be dropped in a later clean-up migration once
-- the app has run on v4 for a while.
