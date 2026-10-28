-- =============================================================================
-- P2-3: Contract Pricing — Price Lists (sector / restaurant custom pricing)
-- =============================================================================

-- price_lists: named price lists scoped to a sector or restaurant
create table if not exists price_lists (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  kind          text not null default 'sector' check (kind in ('sector','restaurant','city')),
  sector_id     uuid references sectors(id) on delete set null,
  restaurant_id uuid references restaurants(id) on delete set null,
  city          text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- price_list_items: overrides published product price
create table if not exists price_list_items (
  id            uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references price_lists(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  price         numeric(10,2) not null,
  min_qty       numeric(10,3),
  created_at    timestamptz not null default now(),
  unique (price_list_id, product_id)
);

alter table price_lists      enable row level security;
alter table price_list_items enable row level security;

-- Admins manage; restaurants can view their own price list
create policy "admin manage price_lists"      on price_lists for all
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "restaurant view own pl"        on price_lists for select
  using (restaurant_id = (select restaurant_id from profiles where id = auth.uid())
      or sector_id     = (select r.sector_id from restaurants r join profiles p on p.restaurant_id = r.id where p.id = auth.uid()));

create policy "admin manage pl_items"         on price_list_items for all
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "restaurant view own pl_items"  on price_list_items for select
  using (price_list_id in (
    select pl.id from price_lists pl
    where  pl.restaurant_id = (select restaurant_id from profiles where id = auth.uid())
       or  pl.sector_id     = (select r.sector_id from restaurants r join profiles p on p.restaurant_id = r.id where p.id = auth.uid())
  ));

-- Function: get the best price for a product for the calling restaurant.
-- place_order uses this to charge the right price.
create or replace function customer_price(p_product_id uuid)
returns numeric
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select pli.price
     from   price_list_items pli
     join   price_lists pl on pl.id = pli.price_list_id
     where  pli.product_id = p_product_id
       and  pl.is_active = true
       and  (pl.restaurant_id = (select restaurant_id from profiles where id = auth.uid())
          or pl.sector_id     = (select r.sector_id from restaurants r join profiles p on p.restaurant_id = r.id where p.id = auth.uid()))
     order  by (pl.restaurant_id is not null) desc   -- restaurant-specific beats sector
     limit  1),
    (select price from products where id = p_product_id)
  );
$$;
grant execute on function customer_price(uuid) to authenticated;

-- Convenience: return all price-list items for the caller's restaurant
create or replace function get_my_price_list()
returns table (product_id uuid, price numeric)
language sql stable security definer
set search_path = public
as $$
  select distinct on (pli.product_id)
         pli.product_id, pli.price
  from   price_list_items pli
  join   price_lists pl on pl.id = pli.price_list_id
  where  pl.is_active = true
    and  (pl.restaurant_id = (select restaurant_id from profiles where id = auth.uid())
       or pl.sector_id     = (select r.sector_id from restaurants r join profiles p on p.restaurant_id = r.id where p.id = auth.uid()))
  order  by pli.product_id, (pl.restaurant_id is not null) desc;
$$;
grant execute on function get_my_price_list() to authenticated;

create index if not exists idx_pl_sector      on price_lists(sector_id) where is_active;
create index if not exists idx_pl_restaurant  on price_lists(restaurant_id) where is_active;
create index if not exists idx_pli_product    on price_list_items(product_id);
create index if not exists idx_pli_pl         on price_list_items(price_list_id);
