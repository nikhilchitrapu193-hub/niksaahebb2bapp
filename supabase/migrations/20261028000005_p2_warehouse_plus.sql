-- =============================================================================
-- P2-5: Warehouse+
-- =============================================================================

-- Storage locations (bins / bays in each warehouse)
create table if not exists storage_locations (
  id           uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references locations(id) on delete cascade,
  code         text not null,
  zone         text,
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (warehouse_id, code)
);

-- Extended inventory: per-location stock + lot/batch tracking
create table if not exists inventory_lots (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references products(id) on delete cascade,
  storage_location_id uuid references storage_locations(id) on delete set null,
  warehouse_id        uuid references locations(id) on delete cascade,
  lot_number          text,
  expiry_date         date,
  qty_on_hand         numeric(12,3) not null default 0,
  qty_reserved        numeric(12,3) not null default 0,
  cost_price          numeric(10,2),
  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Inventory movement log
create table if not exists inventory_movements (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references products(id) on delete cascade,
  inventory_lot_id    uuid references inventory_lots(id) on delete set null,
  warehouse_id        uuid references locations(id),
  kind                text not null check (kind in ('in','out','adj','transfer')),
  qty                 numeric(12,3) not null,
  reference_type      text,    -- 'order', 'purchase_order', 'adjustment', etc.
  reference_id        uuid,
  notes               text,
  created_by          uuid references profiles(id),
  created_at          timestamptz not null default now()
);

-- Expiry alerts: view of lots expiring within 7 days or already expired
create or replace view expiring_lots as
  select il.*, p.name as product_name, p.unit, sl.code as location_code
  from   inventory_lots il
  join   products p on p.id = il.product_id
  left   join storage_locations sl on sl.id = il.storage_location_id
  where  il.expiry_date is not null
    and  il.expiry_date <= current_date + 7
    and  il.qty_on_hand > 0;

alter table storage_locations   enable row level security;
alter table inventory_lots      enable row level security;
alter table inventory_movements enable row level security;

create policy "admin manage storage_locations"   on storage_locations   for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin manage inventory_lots"      on inventory_lots      for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "admin manage inventory_movements" on inventory_movements for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- Warehouse workers can view (delivery role already exists)
create policy "delivery view inventory_lots"     on inventory_lots for select using (exists (select 1 from profiles where id = auth.uid() and role in ('delivery','admin')));

-- Function: adjust stock (called from GRN receipt)
create or replace function adjust_inventory(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_qty          numeric,      -- positive = in, negative = out
  p_kind         text,
  p_reference_id uuid default null,
  p_reference_type text default null,
  p_notes        text default null,
  p_lot_number   text default null,
  p_expiry_date  date default null,
  p_cost_price   numeric default null
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  lot_id uuid;
begin
  -- Upsert lot
  insert into inventory_lots (product_id, warehouse_id, lot_number, expiry_date, qty_on_hand, cost_price)
  values (p_product_id, p_warehouse_id, p_lot_number, p_expiry_date, greatest(p_qty,0), p_cost_price)
  on conflict (product_id, warehouse_id, lot_number) where lot_number is not null
  do update set
    qty_on_hand = inventory_lots.qty_on_hand + p_qty,
    updated_at  = now()
  returning id into lot_id;

  if lot_id is null then
    -- no lot match; insert fresh
    insert into inventory_lots (product_id, warehouse_id, lot_number, expiry_date, qty_on_hand, cost_price)
    values (p_product_id, p_warehouse_id, p_lot_number, p_expiry_date, p_qty, p_cost_price)
    returning id into lot_id;
  end if;

  -- Movement record
  insert into inventory_movements (product_id, inventory_lot_id, warehouse_id, kind, qty, reference_type, reference_id, notes, created_by)
  values (p_product_id, lot_id, p_warehouse_id, p_kind, p_qty, p_reference_type, p_reference_id, p_notes, auth.uid());

  return lot_id;
end;
$$;
grant execute on function adjust_inventory(uuid,uuid,numeric,text,uuid,text,text,text,date,numeric) to service_role;

create index if not exists idx_inventory_lots_product    on inventory_lots(product_id);
create index if not exists idx_inventory_lots_warehouse  on inventory_lots(warehouse_id);
create index if not exists idx_inventory_lots_expiry     on inventory_lots(expiry_date) where expiry_date is not null;
create index if not exists idx_inventory_movements_prod  on inventory_movements(product_id);
create index if not exists idx_storage_locations_wh      on storage_locations(warehouse_id);
