-- =============================================================================
-- Migration 003: Business-rule functions (the "backend") + photo storage
--
-- There is no separate API server. These Postgres functions ARE the backend:
-- the browser calls them with supabase.rpc('function_name', {...}).
--
-- Why functions instead of letting the browser write tables directly?
--   * Prices come from the products table, never from the browser.
--   * Status changes follow strict rules (who may move an order where).
--   * Every function re-checks the caller's role itself. They are SECURITY
--     DEFINER (run with elevated rights), so each one begins with an explicit
--     permission check — that check is the security boundary.
--   * All functions pin search_path = '' and use fully-qualified names, which
--     prevents search-path hijacking.
-- =============================================================================

-- ---------- place_order -------------------------------------------------------
-- Input:  p_items  = [{"product_id": "<uuid>", "quantity": 3}, ...]
--         p_notes  = optional free text for the kitchen/driver
-- Output: {"id": "<uuid>", "order_number": "ORD-1001", "total_amount": 1234.50}

create function public.place_order(p_items jsonb, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_rest      public.restaurants;
  v_order_id  uuid;
  v_number    text;
  v_line      record;
  v_product   public.products;
  v_total     numeric(12,2);
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Only restaurant accounts can place orders' using errcode = '42501';
  end if;

  select * into v_rest from public.restaurants where owner_id = v_uid;
  if not found then
    raise exception 'No restaurant is linked to this account';
  end if;
  if v_rest.status <> 'approved' then
    raise exception 'Your restaurant is not approved yet (status: %). Please wait for admin approval.', v_rest.status;
  end if;
  if length(trim(v_rest.address)) = 0 then
    raise exception 'Add a delivery address to your restaurant profile before ordering';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order must contain at least one item';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'An order can contain at most 100 lines';
  end if;

  insert into public.orders (restaurant_id, placed_by, restaurant_name, delivery_address, contact_phone, notes)
  values (v_rest.id, v_uid, v_rest.name, v_rest.address, v_rest.phone, left(p_notes, 500))
  returning id, order_number into v_order_id, v_number;

  -- Merge duplicate product lines, then validate and price each one.
  for v_line in
    select (e ->> 'product_id')::uuid as product_id,
           sum((e ->> 'quantity')::numeric) as qty
    from jsonb_array_elements(p_items) as e
    group by 1
  loop
    select * into v_product
    from public.products
    where id = v_line.product_id and is_active;

    if not found then
      raise exception 'Product % is not available', v_line.product_id;
    end if;
    if not v_product.in_stock then
      raise exception '"%" is out of stock today', v_product.name;
    end if;
    if v_line.qty is null or v_line.qty < v_product.min_order_qty or v_line.qty > 10000 then
      raise exception 'Quantity for "%" must be between % and 10000', v_product.name, v_product.min_order_qty;
    end if;

    insert into public.order_items (order_id, product_id, product_name, unit, unit_price, quantity)
    values (v_order_id, v_product.id, v_product.name, v_product.unit, v_product.price, v_line.qty);
  end loop;

  select coalesce(sum(line_total), 0) into v_total
  from public.order_items where order_id = v_order_id;

  update public.orders set total_amount = v_total where id = v_order_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by)
  values (v_order_id, null, 'placed', v_uid);

  return jsonb_build_object('id', v_order_id, 'order_number', v_number, 'total_amount', v_total);
end;
$$;

-- ---------- set_order_status --------------------------------------------------
-- The ONLY way an order's status changes. Allowed moves:
--   admin       placed -> confirmed -> packed -> out_for_delivery -> delivered
--               (cancel allowed from any non-final state)
--   restaurant  placed -> cancelled   (own orders only)
--   delivery    packed -> out_for_delivery -> delivered   (assigned orders only)

create function public.set_order_status(
  p_order_id uuid,
  p_new      public.order_status,
  p_note     text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    public.user_role := (select public.app_role());
  v_uid     uuid := (select auth.uid());
  v_order   public.orders;
  v_allowed boolean := false;
begin
  if v_role is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Lock the row so two people can't change the same order simultaneously.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found';
  end if;

  if v_role = 'admin' then
    v_allowed := case v_order.status
      when 'placed'           then p_new in ('confirmed', 'cancelled')
      when 'confirmed'        then p_new in ('packed', 'cancelled')
      when 'packed'           then p_new in ('out_for_delivery', 'cancelled')
      when 'out_for_delivery' then p_new in ('delivered', 'cancelled')
      else false
    end;
  elsif v_role = 'restaurant' then
    v_allowed := v_order.restaurant_id = (select public.my_restaurant_id())
                 and v_order.status = 'placed'
                 and p_new = 'cancelled';
  elsif v_role = 'delivery' then
    v_allowed := v_order.assigned_to = v_uid
                 and ((v_order.status = 'packed' and p_new = 'out_for_delivery')
                   or (v_order.status = 'out_for_delivery' and p_new = 'delivered'));
  end if;

  if not v_allowed then
    raise exception 'You cannot move this order from % to %', v_order.status, p_new
      using errcode = '42501';
  end if;

  if p_new = 'out_for_delivery' and v_order.assigned_to is null then
    raise exception 'Assign a delivery person before dispatching this order';
  end if;

  update public.orders set status = p_new where id = p_order_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, p_new, v_uid, left(p_note, 300));
end;
$$;

-- ---------- assign_delivery ---------------------------------------------------
-- Admin assigns (or clears, with NULL) the delivery person for an open order.

create function public.assign_delivery(p_order_id uuid, p_delivery_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if (select public.app_role()) is distinct from 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status in ('delivered', 'cancelled') then
    raise exception 'This order is already %', v_order.status;
  end if;

  if p_delivery_user is not null and not exists (
    select 1 from public.profiles
    where id = p_delivery_user and role = 'delivery' and is_active
  ) then
    raise exception 'That user is not an active delivery account';
  end if;

  update public.orders set assigned_to = p_delivery_user where id = p_order_id;
end;
$$;

-- ---------- Team management (admin only) ------------------------------------

-- Lists every login with its email (emails live in auth.users, which the
-- browser cannot read directly).
create function public.admin_list_users()
returns table (
  id              uuid,
  email           text,
  role            public.user_role,
  full_name       text,
  phone           text,
  is_active       boolean,
  restaurant_name text,
  restaurant_status public.restaurant_status,
  created_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select public.app_role()) is distinct from 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return query
  select p.id, u.email::text, p.role, p.full_name, p.phone, p.is_active,
         r.name, r.status, p.created_at
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.restaurants r on r.owner_id = p.id
  order by p.created_at desc;
end;
$$;

-- Promote/demote a user or deactivate their login. An admin cannot change
-- their own role/status, so the system can never be left without an admin.
create function public.admin_set_user_role(
  p_user   uuid,
  p_role   public.user_role,
  p_active boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.app_role()) is distinct from 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  if p_user = (select auth.uid()) then
    raise exception 'You cannot change your own role or status';
  end if;

  update public.profiles set role = p_role, is_active = p_active where id = p_user;
  if not found then raise exception 'User not found'; end if;
end;
$$;

-- ---------- Self-service profile edits ---------------------------------------

create function public.update_my_profile(p_full_name text, p_phone text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.app_role()) is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  update public.profiles
  set full_name = left(coalesce(p_full_name, ''), 120),
      phone     = left(p_phone, 20)
  where id = (select auth.uid());
end;
$$;

-- Restaurants edit their own details here; status can't be touched.
create function public.update_my_restaurant(
  p_name    text,
  p_address text,
  p_phone   text,
  p_gstin   text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Restaurant accounts only' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'Restaurant name is required';
  end if;

  update public.restaurants
  set name    = left(trim(p_name), 120),
      address = left(coalesce(p_address, ''), 400),
      phone   = left(p_phone, 20),
      gstin   = left(p_gstin, 20)
  where owner_id = (select auth.uid());

  if not found then raise exception 'No restaurant is linked to this account'; end if;
end;
$$;

-- ---------- Admin dashboard numbers ------------------------------------------
-- "Today" is calculated in India time (IST) because that is where the
-- business operates. Cancelled orders never count towards revenue.

create function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today_start timestamptz :=
    date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
begin
  if (select public.app_role()) is distinct from 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'orders_today',
      (select count(*) from public.orders where created_at >= v_today_start),
    'revenue_today',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= v_today_start and status <> 'cancelled'),
    'revenue_7d',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= now() - interval '7 days' and status <> 'cancelled'),
    'pending_restaurants',
      (select count(*) from public.restaurants where status = 'pending'),
    'open_orders_by_status',
      (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
         select status, count(*) as n from public.orders
         where status not in ('delivered', 'cancelled') group by status) s),
    'top_products_30d',
      (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
         select oi.product_name as name,
                sum(oi.quantity) as quantity,
                sum(oi.line_total) as revenue
         from public.order_items oi
         join public.orders o on o.id = oi.order_id
         where o.created_at >= now() - interval '30 days' and o.status <> 'cancelled'
         group by oi.product_name
         order by sum(oi.line_total) desc
         limit 5) t)
  );
end;
$$;

-- ---------- Function permissions ---------------------------------------------
-- Postgres grants EXECUTE to everyone by default. Remove that, then grant only
-- to logged-in users. Each function still checks the caller's role itself.

revoke execute on function
  public.place_order(jsonb, text),
  public.set_order_status(uuid, public.order_status, text),
  public.assign_delivery(uuid, uuid),
  public.admin_list_users(),
  public.admin_set_user_role(uuid, public.user_role, boolean),
  public.update_my_profile(text, text),
  public.update_my_restaurant(text, text, text, text),
  public.admin_dashboard_stats()
from public, anon;

grant execute on function
  public.place_order(jsonb, text),
  public.set_order_status(uuid, public.order_status, text),
  public.assign_delivery(uuid, uuid),
  public.admin_list_users(),
  public.admin_set_user_role(uuid, public.user_role, boolean),
  public.update_my_profile(text, text),
  public.update_my_restaurant(text, text, text, text),
  public.admin_dashboard_stats()
to authenticated;

-- ---------- Product photo storage --------------------------------------------
-- Public-read bucket (photos aren't secret and load fast without signed URLs).
-- Only admins may upload, replace or delete. 5 MB cap, images only.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy product_photos_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-photos' and (select public.app_role()) = 'admin');

create policy product_photos_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'product-photos' and (select public.app_role()) = 'admin')
  with check (bucket_id = 'product-photos' and (select public.app_role()) = 'admin');

create policy product_photos_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-photos' and (select public.app_role()) = 'admin');
