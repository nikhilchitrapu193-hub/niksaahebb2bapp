-- =============================================================================
-- P2-2: Ordering Plus — Coupons, Standing Orders, Quotes
-- =============================================================================

-- ─── Coupons ─────────────────────────────────────────────────────────────────
create table if not exists coupons (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  kind            text not null check (kind in ('pct','fixed','freeship')),
  value           numeric(10,2) not null default 0,
  min_order_value numeric(10,2) not null default 0,
  max_discount    numeric(10,2),
  starts_at       timestamptz,
  expires_at      timestamptz,
  uses_limit      int,
  uses_count      int not null default 0,
  sector_id       uuid references sectors(id) on delete set null,
  restaurant_id   uuid references restaurants(id) on delete set null,
  description     text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- RLS
alter table coupons enable row level security;
create policy "admin view coupons"   on coupons for select using (auth.role() = 'authenticated');
create policy "admin manage coupons" on coupons for all    using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Validate a coupon code for the calling restaurant
create or replace function coupon_check(p_code text, p_subtotal numeric)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  c   coupons%rowtype;
  r   restaurants%rowtype;
  disc numeric;
begin
  select * into c from coupons where upper(code) = upper(p_code) and is_active = true;
  if not found then raise exception 'Coupon not found or expired'; end if;
  if c.starts_at   is not null and now() < c.starts_at   then raise exception 'Coupon not yet valid'; end if;
  if c.expires_at  is not null and now() > c.expires_at  then raise exception 'Coupon has expired'; end if;
  if c.uses_limit  is not null and c.uses_count >= c.uses_limit then raise exception 'Coupon usage limit reached'; end if;
  if p_subtotal < c.min_order_value then raise exception 'Order minimum ₹% required for this coupon', c.min_order_value; end if;
  -- Sector / restaurant restriction
  select * into r from restaurants where id = (select restaurant_id from profiles where id = auth.uid());
  if c.sector_id      is not null and r.sector_id     is distinct from c.sector_id      then raise exception 'Coupon not valid for your sector'; end if;
  if c.restaurant_id  is not null and r.id            is distinct from c.restaurant_id  then raise exception 'Coupon not valid for this account'; end if;
  -- Compute discount
  disc := case c.kind
    when 'pct'      then round(p_subtotal * c.value / 100, 2)
    when 'fixed'    then c.value
    when 'freeship' then 0  -- delivery fee waiver applied in place_order
    else 0 end;
  if c.max_discount is not null then disc := least(disc, c.max_discount); end if;
  return jsonb_build_object(
    'code', c.code, 'kind', c.kind, 'value', c.value,
    'discount_amount', disc, 'description', c.description
  );
end;
$$;

-- Accept coupon code inside place_order (existing function needs to call this internally).
-- A thin RPC so the restaurant app can validate before submitting.
grant execute on function coupon_check(text, numeric) to authenticated;

-- ─── Standing Orders ─────────────────────────────────────────────────────────
create table if not exists standing_orders (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  label         text,
  days          int[] not null,        -- 0=Sun … 6=Sat
  slot          text not null,
  start_date    date,
  end_date      date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists standing_order_items (
  id               uuid primary key default gen_random_uuid(),
  standing_order_id uuid not null references standing_orders(id) on delete cascade,
  product_id       uuid not null references products(id) on delete cascade,
  qty              numeric(10,3) not null default 1,
  created_at       timestamptz not null default now()
);

alter table standing_orders      enable row level security;
alter table standing_order_items enable row level security;

-- Restaurants manage their own; admin can see all
create policy "restaurant own standing_orders" on standing_orders for all
  using (restaurant_id = (select restaurant_id from profiles where id = auth.uid()))
  with check (restaurant_id = (select restaurant_id from profiles where id = auth.uid()));
create policy "admin view standing_orders" on standing_orders for select
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

create policy "restaurant own so_items" on standing_order_items for all
  using (standing_order_id in (
    select id from standing_orders where restaurant_id = (select restaurant_id from profiles where id = auth.uid())
  ));
create policy "admin view so_items" on standing_order_items for select
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- Function invoked by cron/notification function to place standing orders
create or replace function run_standing_orders()
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  rec record;
  today_dow int := extract(dow from now() at time zone 'Asia/Kolkata');
  today_date date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for rec in
    select so.*
    from   standing_orders so
    where  so.is_active = true
      and  today_dow = any(so.days)
      and  (so.start_date is null or so.start_date <= today_date)
      and  (so.end_date   is null or so.end_date   >= today_date)
  loop
    begin
      insert into orders (restaurant_id, status, delivery_date, slot, payment_method, source, total_amount, notes)
      select rec.restaurant_id, 'pending',
             today_date + 1,    -- deliver tomorrow
             rec.slot, 'cod', 'standing',
             coalesce((
               select sum(p.price * soi.qty)
               from   standing_order_items soi
               join   products p on p.id = soi.product_id
               where  soi.standing_order_id = rec.id
             ), 0),
             'Auto: standing order ' || rec.id::text;
      -- Items
      insert into order_items (order_id, product_id, qty, unit_price)
      select currval(pg_get_serial_sequence('orders','id'))::uuid,
             soi.product_id, soi.qty, p.price
      from   standing_order_items soi
      join   products p on p.id = soi.product_id
      where  soi.standing_order_id = rec.id;
    exception when others then
      null; -- skip failed standing order; don't break the rest
    end;
  end loop;
end;
$$;

grant execute on function run_standing_orders() to service_role;

-- ─── Quotes ──────────────────────────────────────────────────────────────────
create table if not exists quotes (
  id            uuid primary key default gen_random_uuid(),
  quote_number  text not null unique default ('Q-' || lpad(nextval('quote_seq'::regclass)::text,6,'0')),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  status        text not null default 'draft' check (status in ('draft','sent','accepted','declined','expired','converted')),
  note          text,
  expires_at    date,
  order_id      uuid references orders(id) on delete set null,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create sequence if not exists quote_seq start 1 increment 1;

-- Recreate with sequence dependency resolved
alter table quotes alter column quote_number
  set default ('Q-' || lpad(nextval('quote_seq'::regclass)::text,6,'0'));

create table if not exists quote_items (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references quotes(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  description text,
  qty        numeric(10,3) not null default 1,
  unit_price numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

alter table quotes      enable row level security;
alter table quote_items enable row level security;

create policy "restaurant own quotes" on quotes for select
  using (restaurant_id = (select restaurant_id from profiles where id = auth.uid()));
create policy "admin manage quotes" on quotes for all
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "restaurant update quote status" on quotes for update
  using (restaurant_id = (select restaurant_id from profiles where id = auth.uid()))
  with check (status in ('accepted','declined'));

create policy "restaurant view quote_items" on quote_items for select
  using (quote_id in (select id from quotes where restaurant_id = (select restaurant_id from profiles where id = auth.uid())));
create policy "admin manage quote_items" on quote_items for all
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- RPC: Accept a quote (creates an order)
create or replace function accept_quote(p_quote_id uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  q     quotes%rowtype;
  oid   uuid;
begin
  select * into q from quotes where id = p_quote_id
    and restaurant_id = (select restaurant_id from profiles where id = auth.uid())
    and status = 'sent';
  if not found then raise exception 'Quote not available for acceptance'; end if;

  insert into orders (restaurant_id, status, delivery_date, slot, payment_method, total_amount, notes, source)
  values (q.restaurant_id, 'pending', current_date + 1, 'morning', 'cod',
          (select coalesce(sum(qty*unit_price),0) from quote_items where quote_id = q.id),
          'Quote ' || q.quote_number, 'quote')
  returning id into oid;

  insert into order_items (order_id, product_id, qty, unit_price)
  select oid, product_id, qty, unit_price from quote_items where quote_id = q.id;

  update quotes set status = 'converted', order_id = oid, updated_at = now() where id = q.id;
  return oid;
end;
$$;

grant execute on function accept_quote(uuid) to authenticated;

-- Indexes
create index if not exists idx_coupons_code         on coupons(upper(code));
create index if not exists idx_standing_orders_rest  on standing_orders(restaurant_id);
create index if not exists idx_quotes_restaurant     on quotes(restaurant_id);
create index if not exists idx_quote_items_quote     on quote_items(quote_id);
