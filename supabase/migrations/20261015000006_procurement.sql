-- =============================================================================
-- Migration 011: Procurement (build list section 5, Phase 1, batch 4).
--
--   demand → buying list → purchase order → goods received with quality check
--
--   * Permission module "procurement" (view / edit / approve / export).
--   * Supplier rate cards: supplier_products — each supplier's price per
--     product, MOQ, lead days, validity, one preferred supplier per product.
--   * Purchase orders: purchase_orders + purchase_order_items, numbered PO-1000…,
--     draft → sent (approve) → part_received / closed, or cancelled.
--   * Goods receipts (GRN): goods_receipts + goods_receipt_items, numbered
--     GRN-1000…, against a PO, a mandi cash purchase (bill photo, cash paid) or
--     a direct delivery. Each line: accepted, rejected (with reason), grade,
--     photo, unit cost. Accepted quantity enters the stock ledger through
--     apply_stock_movement() with its cost; rejected goods never do.
--   * Buying list: buying_list(warehouse, date) — demand for the day, physical
--     and free stock, open POs, and a suggested quantity to buy.
--
-- Decision record: docs/adr/0015-procurement-po-grn-buying-list.md
-- =============================================================================

-- ---------- 1. Permission module "procurement" --------------------------------

do $$
begin
  execute 'alter table public.role_permissions drop constraint role_permissions_module_check';
  execute $c$alter table public.role_permissions add constraint role_permissions_module_check
    check (module in ('dashboard', 'orders', 'products', 'inventory', 'customers', 'payments',
                      'team', 'settings', 'audit', 'reports', 'pricing', 'procurement'))$c$;
end $$;

-- view = buying list, POs, receipts, rate cards; edit = create / change POs,
-- rate cards; approve = approve & send a PO; export = CSV.
-- Receiving goods stays an inventory:edit action (it changes stock).
insert into public.role_permissions (team_role, module, action)
select v.role, 'procurement', a.action
from (values
  ('procurement_buyer', 'view,edit,export'),
  ('city_manager',      'view,edit,approve,export'),
  ('warehouse_manager', 'view')
) as v (role, actions)
cross join lateral unnest(string_to_array(v.actions, ',')) as a (action)
on conflict do nothing;

-- ---------- 2. Supplier rate cards -------------------------------------------

create table public.supplier_products (
  id           uuid primary key default gen_random_uuid(),
  supplier_id  uuid not null references public.suppliers (id) on delete cascade,
  product_id   uuid not null references public.products (id) on delete cascade,
  price        numeric(12,2) not null check (price >= 0),        -- per selling unit of the product
  moq          numeric(10,2) not null default 1 check (moq > 0),
  lead_days    integer not null default 1 check (lead_days >= 0),
  is_preferred boolean not null default false,
  valid_from   date not null default (now() at time zone 'Asia/Kolkata')::date,
  valid_to     date check (valid_to is null or valid_to >= valid_from),
  note         text,
  updated_at   timestamptz not null default now(),
  unique (supplier_id, product_id)
);
create unique index supplier_products_preferred_idx on public.supplier_products (product_id) where is_preferred;
create index supplier_products_product_idx on public.supplier_products (product_id);
comment on table public.supplier_products is
  'Rate cards: what each supplier charges per product. One preferred supplier per product feeds the buying list and PO defaults.';
create trigger supplier_products_set_updated_at before update on public.supplier_products
  for each row execute function public.set_updated_at();

-- Rate card in force today for a product from its preferred supplier (else the cheapest valid one).
create function public.preferred_rate(p_product_id uuid)
returns public.supplier_products
language sql
stable
set search_path = ''
as $$
  select sp.* from public.supplier_products sp
  join public.suppliers s on s.id = sp.supplier_id and s.is_active
  where sp.product_id = p_product_id
    and sp.valid_from <= (now() at time zone 'Asia/Kolkata')::date
    and (sp.valid_to is null or sp.valid_to >= (now() at time zone 'Asia/Kolkata')::date)
  order by sp.is_preferred desc, sp.price asc
  limit 1
$$;

-- ---------- 3. Purchase orders --------------------------------------------------

create sequence public.po_number_seq start 1000;
create sequence public.grn_number_seq start 1000;

create table public.purchase_orders (
  id             uuid primary key default gen_random_uuid(),
  po_number      text not null unique default ('PO-' || nextval('public.po_number_seq')::text),
  supplier_id    uuid references public.suppliers (id) on delete restrict,
  warehouse_id   uuid not null references public.warehouses (id) on delete restrict,
  city_id        uuid not null references public.cities (id) on delete restrict,
  status         text not null default 'draft' check (status in ('draft', 'sent', 'part_received', 'closed', 'cancelled')),
  expected_date  date,
  notes          text,
  created_by     uuid references public.profiles (id) on delete set null,
  approved_by    uuid references public.profiles (id) on delete set null,
  approved_at    timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index purchase_orders_status_idx on public.purchase_orders (status, expected_date);
create index purchase_orders_supplier_idx on public.purchase_orders (supplier_id);
comment on table public.purchase_orders is
  'draft (buyer builds it) → sent (approved; shown to the supplier) → part_received / closed (by receipts or by hand) · cancelled.';
create trigger purchase_orders_set_updated_at before update on public.purchase_orders
  for each row execute function public.set_updated_at();

create table public.purchase_order_items (
  id            uuid primary key default gen_random_uuid(),
  po_id         uuid not null references public.purchase_orders (id) on delete cascade,
  product_id    uuid not null references public.products (id) on delete restrict,
  qty_ordered   numeric(10,2) not null check (qty_ordered > 0),
  unit_cost     numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  qty_received  numeric(10,2) not null default 0 check (qty_received >= 0),
  qty_rejected  numeric(10,2) not null default 0 check (qty_rejected >= 0),
  note          text,
  unique (po_id, product_id)
);

-- ---------- 4. Goods receipts (GRN) ------------------------------------------------

create table public.goods_receipts (
  id              uuid primary key default gen_random_uuid(),
  grn_number      text not null unique default ('GRN-' || nextval('public.grn_number_seq')::text),
  po_id           uuid references public.purchase_orders (id) on delete set null,
  supplier_id     uuid references public.suppliers (id) on delete set null,
  warehouse_id    uuid not null references public.warehouses (id) on delete restrict,
  city_id         uuid not null references public.cities (id) on delete restrict,
  source          text not null check (source in ('po', 'mandi', 'direct')),
  bill_photo_path text,                                  -- purchase-bills bucket
  bill_amount     numeric(12,2) check (bill_amount is null or bill_amount >= 0),
  paid_cash       boolean not null default false,        -- mandi: paid on the spot
  note            text,
  received_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index goods_receipts_po_idx on public.goods_receipts (po_id);
create index goods_receipts_created_idx on public.goods_receipts (created_at desc);
comment on table public.goods_receipts is
  'One note per delivery. source: po (against a purchase order), mandi (cash purchase, bill photo), direct (no PO).';

create table public.goods_receipt_items (
  id             uuid primary key default gen_random_uuid(),
  grn_id         uuid not null references public.goods_receipts (id) on delete cascade,
  product_id     uuid not null references public.products (id) on delete restrict,
  qty_accepted   numeric(10,2) not null default 0 check (qty_accepted >= 0),
  qty_rejected   numeric(10,2) not null default 0 check (qty_rejected >= 0),
  unit_cost      numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  grade          text,
  reject_reason  text,
  photo_path     text,
  check (qty_accepted + qty_rejected > 0)
);
create index goods_receipt_items_grn_idx on public.goods_receipt_items (grn_id);

-- Bill / quality photos: private bucket, staff only (signed URLs in the app).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-bills', 'purchase-bills', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy purchase_bills_staff_select on storage.objects for select to authenticated
  using (bucket_id = 'purchase-bills' and (select public.has_permission('inventory', 'view')));
create policy purchase_bills_staff_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'purchase-bills' and (select public.has_permission('inventory', 'edit')));

-- ---------- 5. Audit ------------------------------------------------------------

create trigger audit_supplier_products   after insert or update or delete on public.supplier_products   for each row execute function public.write_audit_log();
create trigger audit_purchase_orders     after insert or update or delete on public.purchase_orders     for each row execute function public.write_audit_log();
create trigger audit_purchase_order_items after insert or update or delete on public.purchase_order_items for each row execute function public.write_audit_log();
create trigger audit_goods_receipts      after insert or update or delete on public.goods_receipts      for each row execute function public.write_audit_log();
create trigger audit_suppliers           after insert or update or delete on public.suppliers           for each row execute function public.write_audit_log();

-- ---------- 6. Purchase order functions ----------------------------------------------

-- Build a PO (procurement:edit, warehouse in scope). p_items = [{product_id, quantity, unit_cost?}];
-- a missing unit_cost takes the supplier's rate card. Returns {id, po_number}.
create function public.create_purchase_order(
  p_supplier_id   uuid,
  p_warehouse_id  uuid,
  p_expected_date date,
  p_notes         text,
  p_items         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_city  uuid;
  v_po    uuid;
  v_num   text;
  v_line  record;
  v_cost  numeric;
begin
  if not (select public.has_permission('procurement', 'edit')) then
    raise exception 'You do not have permission to create purchase orders' using errcode = '42501';
  end if;
  select city_id into v_city from public.warehouses where id = p_warehouse_id and is_active;
  if v_city is null then raise exception 'Choose an active warehouse'; end if;
  if not (select public.in_my_scope(v_city, p_warehouse_id)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;
  if p_supplier_id is null or not exists (select 1 from public.suppliers where id = p_supplier_id and is_active) then
    raise exception 'Choose an active supplier';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one line';
  end if;

  insert into public.purchase_orders (supplier_id, warehouse_id, city_id, expected_date, notes, created_by)
  values (p_supplier_id, p_warehouse_id, v_city, p_expected_date, left(p_notes, 500), v_uid)
  returning id, po_number into v_po, v_num;

  for v_line in
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::numeric) as qty, max((e ->> 'unit_cost')::numeric) as unit_cost
    from jsonb_array_elements(p_items) as e group by 1
  loop
    if v_line.qty is null or v_line.qty <= 0 then raise exception 'Quantity must be more than 0'; end if;
    v_cost := v_line.unit_cost;
    if v_cost is null then
      select sp.price into v_cost from public.supplier_products sp
      where sp.supplier_id = p_supplier_id and sp.product_id = v_line.product_id
        and sp.valid_from <= (now() at time zone 'Asia/Kolkata')::date and (sp.valid_to is null or sp.valid_to >= (now() at time zone 'Asia/Kolkata')::date);
    end if;
    insert into public.purchase_order_items (po_id, product_id, qty_ordered, unit_cost)
    values (v_po, v_line.product_id, v_line.qty, v_cost);
  end loop;

  return jsonb_build_object('id', v_po, 'po_number', v_num);
end;
$$;

-- Replace the lines and details of a DRAFT PO (procurement:edit, in scope).
create function public.update_purchase_order(p_po_id uuid, p_expected_date date, p_notes text, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po   public.purchase_orders;
  v_line record;
begin
  if not (select public.has_permission('procurement', 'edit')) then
    raise exception 'You do not have permission to change purchase orders' using errcode = '42501';
  end if;
  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if not (select public.in_my_scope(v_po.city_id, v_po.warehouse_id)) then
    raise exception 'This purchase order is outside your scope' using errcode = '42501';
  end if;
  if v_po.status <> 'draft' then raise exception 'Only a draft can be edited (this one is %)', v_po.status; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one line';
  end if;
  -- Replace the lines: remove the old ones, insert the new ones.
  -- (This statement is why migration 011 must be applied from the Supabase SQL editor, not the MCP tool —
  --  see docs/deployment.md, "Applying migrations".)
  delete from public.purchase_order_items where po_id = p_po_id;
  for v_line in
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::numeric) as qty, max((e ->> 'unit_cost')::numeric) as unit_cost
    from jsonb_array_elements(p_items) as e group by 1
  loop
    if v_line.qty is null or v_line.qty <= 0 then raise exception 'Quantity must be more than 0'; end if;
    insert into public.purchase_order_items (po_id, product_id, qty_ordered, unit_cost) values (p_po_id, v_line.product_id, v_line.qty, v_line.unit_cost);
  end loop;
  update public.purchase_orders set expected_date = p_expected_date, notes = left(p_notes, 500) where id = p_po_id;
end;
$$;

-- Move a PO along: sent (needs procurement:approve), closed (short-close, edit), cancelled (edit; nothing received).
create function public.set_purchase_order_status(p_po_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_po  public.purchase_orders;
begin
  select * into v_po from public.purchase_orders where id = p_po_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if not (select public.in_my_scope(v_po.city_id, v_po.warehouse_id)) then
    raise exception 'This purchase order is outside your scope' using errcode = '42501';
  end if;

  if p_status = 'sent' then
    if not (select public.has_permission('procurement', 'approve')) then
      raise exception 'You do not have permission to approve purchase orders' using errcode = '42501';
    end if;
    if v_po.status <> 'draft' then raise exception 'Only a draft can be approved and sent'; end if;
    if not exists (select 1 from public.purchase_order_items where po_id = p_po_id) then raise exception 'The purchase order has no lines'; end if;
    update public.purchase_orders set status = 'sent', approved_by = v_uid, approved_at = now() where id = p_po_id;
  elsif p_status = 'closed' then
    if not (select public.has_permission('procurement', 'edit')) then
      raise exception 'You do not have permission to close purchase orders' using errcode = '42501';
    end if;
    if v_po.status not in ('sent', 'part_received') then raise exception 'Only a sent or part-received purchase order can be closed'; end if;
    update public.purchase_orders set status = 'closed', closed_at = now() where id = p_po_id;
  elsif p_status = 'cancelled' then
    if not (select public.has_permission('procurement', 'edit')) then
      raise exception 'You do not have permission to cancel purchase orders' using errcode = '42501';
    end if;
    if v_po.status not in ('draft', 'sent') then raise exception 'A purchase order with receipts cannot be cancelled; close it instead'; end if;
    if exists (select 1 from public.goods_receipts where po_id = p_po_id) then raise exception 'Goods were already received against this purchase order; close it instead'; end if;
    update public.purchase_orders set status = 'cancelled', closed_at = now() where id = p_po_id;
  else
    raise exception 'Unknown status %', p_status;
  end if;
end;
$$;

-- ---------- 7. Receiving goods with a quality check ------------------------------------
-- inventory:edit, warehouse in scope. p_items = [{product_id, qty_accepted, qty_rejected,
-- unit_cost, grade, reject_reason, photo_path}]. Accepted quantity enters the stock ledger
-- (reason received, with the cost); rejected quantity is only recorded. Against a PO the
-- lines must be on the PO; the PO becomes part_received or closed.
create function public.receive_goods(
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
           e ->> 'grade' as grade, e ->> 'reject_reason' as reject_reason, e ->> 'photo_path' as photo_path
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

    insert into public.goods_receipt_items (grn_id, product_id, qty_accepted, qty_rejected, unit_cost, grade, reject_reason, photo_path)
    values (v_grn, v_line.product_id, v_line.accepted, v_line.rejected, v_line.unit_cost, v_line.grade, v_line.reject_reason, v_line.photo_path);

    -- Only what passed the check goes into stock (rule: the ledger holds goods we can sell).
    if v_line.accepted > 0 then
      perform public.apply_stock_movement(v_wh, v_line.product_id, v_line.accepted, 'received', v_supplier, null, v_line.unit_cost, v_num);
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

-- ---------- 8. The buying list -------------------------------------------------------------
-- For one warehouse and delivery date (procurement:view, in scope), per active product:
--   demand       = quantity on orders for that date (placed / confirmed / packed)
--   free_stock   = warehouse_stock.qty (orders reserve stock when placed, so this is what is
--                  left after every open order, including that day's)
--   open_po_qty  = ordered − received − rejected on sent / part-received POs for the warehouse
--   suggested    = max(0, demand × p_cover_days + low_stock_threshold − free_stock − open_po_qty)
-- i.e. buy enough to cover the same demand again (p_cover_days, default 1) and the alert level.
-- Mirrored by suggestedBuy() in web/js/core/procurement.js.
create function public.buying_list(p_warehouse_id uuid, p_delivery_date date, p_cover_days numeric default 1)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_city uuid;
begin
  if not (select public.has_permission('procurement', 'view')) then
    raise exception 'You do not have permission to view the buying list' using errcode = '42501';
  end if;
  select city_id into v_city from public.warehouses where id = p_warehouse_id;
  if not (select public.in_my_scope(v_city, p_warehouse_id)) then
    raise exception 'That warehouse is outside your scope' using errcode = '42501';
  end if;
  return query
    with demand as (
      select i.product_id, sum(i.quantity) as qty, count(distinct o.id) as orders
      from public.orders o join public.order_items i on i.order_id = o.id
      where o.warehouse_id = p_warehouse_id and o.delivery_date = p_delivery_date
        and o.status in ('placed', 'confirmed', 'packed')
      group by i.product_id
    ),
    open_po as (
      select i.product_id, sum(greatest(i.qty_ordered - i.qty_received - i.qty_rejected, 0)) as qty
      from public.purchase_orders po join public.purchase_order_items i on i.po_id = po.id
      where po.warehouse_id = p_warehouse_id and po.status in ('sent', 'part_received')
      group by i.product_id
    )
    select jsonb_build_object(
      'product_id', p.id, 'sku', p.sku, 'name', p.name, 'unit', p.unit, 'category_name', public.category_path(p.category_id),
      'demand_qty', coalesce(d.qty, 0), 'demand_orders', coalesce(d.orders, 0),
      'free_stock', coalesce(ws.qty, 0), 'low_stock_threshold', p.low_stock_threshold,
      'open_po_qty', coalesce(op.qty, 0),
      'suggested_qty', greatest(0, coalesce(d.qty, 0) * p_cover_days + p.low_stock_threshold - coalesce(ws.qty, 0) - coalesce(op.qty, 0)),
      'supplier_id', r.supplier_id, 'supplier_name', s.name, 'rate', r.price, 'moq', r.moq, 'lead_days', r.lead_days,
      'latest_cost', c.latest_cost, 'avg_cost_30d', c.avg_cost_30d
    )
    from public.products p
    left join demand d on d.product_id = p.id
    left join public.warehouse_stock ws on ws.product_id = p.id and ws.warehouse_id = p_warehouse_id
    left join open_po op on op.product_id = p.id
    left join lateral public.preferred_rate(p.id) r on true
    left join public.suppliers s on s.id = r.supplier_id
    left join public.v_product_cost c on c.product_id = p.id
    where p.is_active
    order by (coalesce(d.qty, 0) > 0) desc, p.name;
end;
$$;

-- ---------- 9. Row Level Security and grants ----------------------------------------------

alter table public.supplier_products    enable row level security;
alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.goods_receipts       enable row level security;
alter table public.goods_receipt_items  enable row level security;
revoke all on public.supplier_products, public.purchase_orders, public.purchase_order_items,
              public.goods_receipts, public.goods_receipt_items from anon;

-- Rate cards: procurement:view reads, procurement:edit writes.
create policy supplier_products_select on public.supplier_products for select to authenticated using ((select public.has_permission('procurement', 'view')));
create policy supplier_products_write  on public.supplier_products for all    to authenticated
  using ((select public.has_permission('procurement', 'edit'))) with check ((select public.has_permission('procurement', 'edit')));

-- POs and receipts: read with procurement:view (receipts also inventory:view), within scope; written only by the functions.
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using ((select public.has_permission('procurement', 'view')) and (select public.in_my_scope(city_id, warehouse_id)));
create policy purchase_order_items_select on public.purchase_order_items for select to authenticated
  using (exists (select 1 from public.purchase_orders po where po.id = po_id
                 and (select public.has_permission('procurement', 'view')) and (select public.in_my_scope(po.city_id, po.warehouse_id))));
create policy goods_receipts_select on public.goods_receipts for select to authenticated
  using (((select public.has_permission('procurement', 'view')) or (select public.has_permission('inventory', 'view')))
         and (select public.in_my_scope(city_id, warehouse_id)));
create policy goods_receipt_items_select on public.goods_receipt_items for select to authenticated
  using (exists (select 1 from public.goods_receipts g where g.id = grn_id
                 and ((select public.has_permission('procurement', 'view')) or (select public.has_permission('inventory', 'view')))
                 and (select public.in_my_scope(g.city_id, g.warehouse_id))));
revoke all on public.purchase_orders, public.purchase_order_items,
              public.goods_receipts, public.goods_receipt_items from authenticated;
grant select on public.purchase_orders, public.purchase_order_items,
                public.goods_receipts, public.goods_receipt_items to authenticated;

revoke execute on function public.preferred_rate(uuid)                                        from public, anon, authenticated;
revoke execute on function public.create_purchase_order(uuid, uuid, date, text, jsonb)        from public, anon;
revoke execute on function public.update_purchase_order(uuid, date, text, jsonb)              from public, anon;
revoke execute on function public.set_purchase_order_status(uuid, text)                       from public, anon;
revoke execute on function public.receive_goods(uuid, uuid, uuid, text, jsonb, text, text, numeric, boolean) from public, anon;
revoke execute on function public.buying_list(uuid, date, numeric)                            from public, anon;
grant execute on function public.create_purchase_order(uuid, uuid, date, text, jsonb)         to authenticated;
grant execute on function public.update_purchase_order(uuid, date, text, jsonb)               to authenticated;
grant execute on function public.set_purchase_order_status(uuid, text)                        to authenticated;
grant execute on function public.receive_goods(uuid, uuid, uuid, text, jsonb, text, text, numeric, boolean) to authenticated;
grant execute on function public.buying_list(uuid, date, numeric)                             to authenticated;
