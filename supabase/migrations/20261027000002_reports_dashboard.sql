-- =============================================================================
-- Migration 019: Reports & dashboard (Phase 1, batch 10).
--
--   * sales_report(): orders between two dates grouped by day / city / sector /
--     customer / product / category, in the caller's scope (reports:view);
--     the Reports screen shows it and exports CSV (reports:export).
--   * receivables_trend(): per week — invoiced, collected, open and overdue at the
--     week's end — computed from orders and allocations as they stood then.
--   * admin_dashboard_stats(p_city_id): the dashboard can be narrowed to one city
--     (within the caller's scope) and carries 14 days of orders / revenue.
--   * Customer documents: FSSAI licence and GST certificate uploaded to a private
--     bucket (customer-documents) by the customer (Account) or staff (Customers);
--     paths on restaurants.fssai_doc_path / gst_doc_path; shown before Approve.
--   * Content pages (About, Terms, Privacy, Refund policy) edited under Settings
--     → Website, rendered by page.html on the public site, linked in the footer.
--   * SEO basics: company_settings.seo_title / seo_description for the home page.
--
-- Decision record: docs/adr/0024-reports-computed-not-stored.md
-- =============================================================================

-- ---------- 1. Sales report ------------------------------------------------------

-- p_group_by: 'day' | 'city' | 'sector' | 'customer' | 'product' | 'category'.
-- Dates are India-time order creation dates (inclusive). Cancelled orders are
-- counted separately and excluded from the money columns. Scope: in_my_scope,
-- optionally narrowed to one city.
create function public.sales_report(p_from date, p_to date, p_group_by text default 'day', p_city_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz;
  v_to   timestamptz;
  v_rows jsonb;
begin
  if not (select public.has_permission('reports', 'view')) then
    raise exception 'You do not have permission to see reports' using errcode = '42501';
  end if;
  if p_group_by not in ('day', 'city', 'sector', 'customer', 'product', 'category') then
    raise exception 'Unknown grouping %', p_group_by;
  end if;
  if p_to < p_from then raise exception 'The end date is before the start date'; end if;
  if p_to - p_from > 370 then raise exception 'Choose a range of at most a year'; end if;
  v_from := p_from::timestamp at time zone 'Asia/Kolkata';
  v_to   := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';

  if p_group_by in ('product', 'category') then
    select coalesce(jsonb_agg(t order by t.total desc), '[]'::jsonb) into v_rows from (
      select case when p_group_by = 'product' then oi.product_id::text else coalesce(pr.category_id::text, 'none') end as key,
             case when p_group_by = 'product' then oi.product_name else coalesce(c.name, 'Uncategorised') end as label,
             count(distinct o.id) filter (where o.status <> 'cancelled') as orders,
             sum(oi.quantity) filter (where o.status <> 'cancelled') as quantity,
             sum(oi.line_total) filter (where o.status <> 'cancelled') as subtotal,
             0::numeric as tax, 0::numeric as delivery_fee,
             sum(oi.line_total) filter (where o.status <> 'cancelled') as total,
             count(distinct o.id) filter (where o.status = 'cancelled') as cancelled
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      left join public.products pr on pr.id = oi.product_id
      left join public.categories c on c.id = pr.category_id
      where o.created_at >= v_from and o.created_at < v_to
        and public.in_my_scope(o.city_id, o.warehouse_id)
        and (p_city_id is null or o.city_id = p_city_id)
      group by 1, 2) t;
  else
    select coalesce(jsonb_agg(t order by (case when p_group_by = 'day' then t.key end), t.total desc), '[]'::jsonb) into v_rows from (
      select case p_group_by
               when 'day' then to_char(o.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD')
               when 'city' then coalesce(o.city_id::text, 'none')
               when 'sector' then o.sector_code
               else o.restaurant_id::text end as key,
             case p_group_by
               when 'day' then to_char(o.created_at at time zone 'Asia/Kolkata', 'DD Mon YYYY')
               when 'city' then coalesce(ci.name, 'No city')
               when 'sector' then coalesce(s.name, o.sector_code)
               else coalesce(r.name, o.restaurant_name) end as label,
             count(*) filter (where o.status <> 'cancelled') as orders,
             null::numeric as quantity,
             sum(o.subtotal) filter (where o.status <> 'cancelled') as subtotal,
             sum(o.tax_amount) filter (where o.status <> 'cancelled') as tax,
             sum(o.delivery_fee) filter (where o.status <> 'cancelled') as delivery_fee,
             sum(o.total_amount) filter (where o.status <> 'cancelled') as total,
             count(*) filter (where o.status = 'cancelled') as cancelled
      from public.orders o
      left join public.cities ci on ci.id = o.city_id
      left join public.sectors s on s.code = o.sector_code
      left join public.restaurants r on r.id = o.restaurant_id
      where o.created_at >= v_from and o.created_at < v_to
        and public.in_my_scope(o.city_id, o.warehouse_id)
        and (p_city_id is null or o.city_id = p_city_id)
      group by 1, 2) t;
  end if;
  return v_rows;
end;
$$;
revoke execute on function public.sales_report(date, date, text, uuid) from public, anon;
grant  execute on function public.sales_report(date, date, text, uuid) to authenticated;

-- ---------- 2. Receivables trend ---------------------------------------------------

-- One row per week ending on a Sunday (India time), newest last:
--   invoiced   = delivered credit + COD totals delivered that week
--   collected  = allocations (receipts and credit notes) made that week
--   open       = what delivered orders still owed at the end of that week
--   overdue    = the part of that whose due date had passed by then
create function public.receivables_trend(p_weeks integer default 12, p_city_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last date := date_trunc('week', (now() at time zone 'Asia/Kolkata')::date + 1)::date + 5;  -- this week's Sunday
begin
  if not (select public.has_permission('reports', 'view')) then
    raise exception 'You do not have permission to see reports' using errcode = '42501';
  end if;
  p_weeks := greatest(1, least(coalesce(p_weeks, 12), 52));
  return (
    select coalesce(jsonb_agg(w order by w.week_end), '[]'::jsonb) from (
      select we.week_end,
        (select coalesce(sum(o.total_amount), 0) from public.orders o
          where o.status = 'delivered' and (o.delivered_at at time zone 'Asia/Kolkata')::date between we.week_end - 6 and we.week_end
            and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)) as invoiced,
        (select coalesce(sum(a.amount), 0) from public.payment_allocations a join public.orders o on o.id = a.order_id
          where (a.created_at at time zone 'Asia/Kolkata')::date between we.week_end - 6 and we.week_end
            and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)) as collected,
        (select coalesce(sum(o.total_amount - coalesce((select sum(a.amount) from public.payment_allocations a
                                                       where a.order_id = o.id and (a.created_at at time zone 'Asia/Kolkata')::date <= we.week_end), 0)), 0)
          from public.orders o
          where o.status = 'delivered' and (o.delivered_at at time zone 'Asia/Kolkata')::date <= we.week_end
            and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)) as open,
        (select coalesce(sum(o.total_amount - coalesce((select sum(a.amount) from public.payment_allocations a
                                                       where a.order_id = o.id and (a.created_at at time zone 'Asia/Kolkata')::date <= we.week_end), 0)), 0)
          from public.orders o
          where o.status = 'delivered' and (o.delivered_at at time zone 'Asia/Kolkata')::date <= we.week_end
            and o.due_date is not null and o.due_date < we.week_end
            and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)) as overdue
      from (select (v_last - 7 * g)::date as week_end from generate_series(0, p_weeks - 1) g) we) w);
end;
$$;
revoke execute on function public.receivables_trend(integer, uuid) from public, anon;
grant  execute on function public.receivables_trend(integer, uuid) to authenticated;

-- ---------- 3. Dashboard filtered by city + 14-day series -------------------------

-- The zero-argument version from migration 015 stays for older callers; the app
-- calls this one. A city outside the caller's scope returns nothing (in_my_scope).
create function public.admin_dashboard_stats(p_city_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not (select public.has_permission('dashboard', 'view')) then
    raise exception 'You do not have permission to see the dashboard' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'city_id', p_city_id,
    'orders_today',
      (select count(*) from public.orders where created_at >= v_today_start and public.in_my_scope(city_id, warehouse_id) and (p_city_id is null or city_id = p_city_id)),
    'revenue_today',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= v_today_start and status <> 'cancelled' and public.in_my_scope(city_id, warehouse_id) and (p_city_id is null or city_id = p_city_id)),
    'revenue_7d',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= now() - interval '7 days' and status <> 'cancelled' and public.in_my_scope(city_id, warehouse_id) and (p_city_id is null or city_id = p_city_id)),
    'pending_restaurants',
      (select count(*) from public.restaurants where status = 'pending' and public.in_my_scope(city_id, warehouse_id) and (p_city_id is null or city_id = p_city_id)),
    'open_orders_by_status',
      (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
         select status, count(*) as n from public.orders
         where status not in ('delivered', 'cancelled') and public.in_my_scope(city_id, warehouse_id) and (p_city_id is null or city_id = p_city_id) group by status) s),
    'top_products_30d',
      (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
         select oi.product_name as name, sum(oi.quantity) as quantity, sum(oi.line_total) as revenue
         from public.order_items oi join public.orders o on o.id = oi.order_id
         where o.created_at >= now() - interval '30 days' and o.status <> 'cancelled'
           and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)
         group by oi.product_name order by sum(oi.line_total) desc limit 5) t),
    'receivables_open',
      (select coalesce(sum(o.total_amount - public.allocated_to_order(o.id)), 0) from public.orders o
        where o.status = 'delivered' and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)
          and o.total_amount - public.allocated_to_order(o.id) > 0),
    'receivables_overdue',
      (select coalesce(sum(o.total_amount - public.allocated_to_order(o.id)), 0) from public.orders o
        where o.status = 'delivered' and o.due_date < v_today and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)
          and o.total_amount - public.allocated_to_order(o.id) > 0),
    -- Batch 10: the last 14 days, oldest first, for the small bar chart.
    'daily_14d',
      (select coalesce(jsonb_agg(d order by d.day), '[]'::jsonb) from (
         select to_char(v_today - g, 'YYYY-MM-DD') as day,
                (select count(*) from public.orders o where (o.created_at at time zone 'Asia/Kolkata')::date = v_today - g and o.status <> 'cancelled'
                   and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)) as orders,
                (select coalesce(sum(o.total_amount), 0) from public.orders o where (o.created_at at time zone 'Asia/Kolkata')::date = v_today - g and o.status <> 'cancelled'
                   and public.in_my_scope(o.city_id, o.warehouse_id) and (p_city_id is null or o.city_id = p_city_id)) as revenue
         from generate_series(13, 0, -1) g) d),
    'open_tickets',
      (select count(*) from public.support_tickets t join public.restaurants r on r.id = t.restaurant_id
        where t.status in ('open', 'waiting_customer') and public.in_my_scope(r.city_id, r.warehouse_id) and (p_city_id is null or r.city_id = p_city_id))
  );
end;
$$;
revoke execute on function public.admin_dashboard_stats(uuid) from public, anon;
grant  execute on function public.admin_dashboard_stats(uuid) to authenticated;

-- ---------- 4. Customer documents ---------------------------------------------------

alter table public.restaurants
  add column fssai_doc_path text,
  add column gst_doc_path   text;
comment on column public.restaurants.fssai_doc_path is 'Object path in the customer-documents bucket: <restaurant id>/fssai.<ext>. Uploaded by the customer (Account) or staff (Customers).';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-documents', 'customer-documents', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;
-- The customer reads / writes their own folder (<restaurant id>/...); staff with customers:view read, customers:edit write.
create policy customer_documents_select on storage.objects for select to authenticated
  using (bucket_id = 'customer-documents'
         and ((storage.foldername(name))[1] = (select public.my_restaurant_id())::text
              or (select public.has_permission('customers', 'view'))));
create policy customer_documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'customer-documents'
              and ((storage.foldername(name))[1] = (select public.my_restaurant_id())::text
                   or (select public.has_permission('customers', 'edit'))));
create policy customer_documents_update on storage.objects for update to authenticated
  using (bucket_id = 'customer-documents'
         and ((storage.foldername(name))[1] = (select public.my_restaurant_id())::text
              or (select public.has_permission('customers', 'edit'))));

-- Record the uploaded path. The customer sets their own; staff (customers:edit, in scope) set any.
create function public.set_customer_document(p_restaurant_id uuid, p_kind text, p_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest public.restaurants;
  v_rid  uuid := coalesce(p_restaurant_id, (select public.my_restaurant_id()));
begin
  if p_kind not in ('fssai', 'gst') then raise exception 'Unknown document kind %', p_kind; end if;
  select * into v_rest from public.restaurants where id = v_rid;
  if not found then raise exception 'Customer not found'; end if;
  if not (v_rest.owner_id = (select auth.uid())
          or ((select public.has_permission('customers', 'edit')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)))) then
    raise exception 'You cannot change this customer''s documents' using errcode = '42501';
  end if;
  if p_path is not null and split_part(p_path, '/', 1) <> v_rid::text then
    raise exception 'The document path must start with the customer id';
  end if;
  if p_kind = 'fssai' then update public.restaurants set fssai_doc_path = p_path where id = v_rid;
  else update public.restaurants set gst_doc_path = p_path where id = v_rid; end if;
end;
$$;
revoke execute on function public.set_customer_document(uuid, text, text) from public, anon;
grant  execute on function public.set_customer_document(uuid, text, text) to authenticated;

-- ---------- 5. Content pages and SEO -------------------------------------------------

create table public.content_pages (
  slug           text primary key check (slug ~ '^[a-z0-9-]+$'),
  title          text not null,
  body           text not null,                 -- plain text; blank line = paragraph; a line starting with "## " = heading
  is_published   boolean not null default true,
  show_in_footer boolean not null default true,
  sort_order     integer not null default 0,
  updated_at     timestamptz not null default now()
);
create trigger content_pages_set_updated_at before update on public.content_pages for each row execute function public.set_updated_at();
comment on table public.content_pages is 'Public website pages (About, Terms, Privacy, Refund policy…) rendered by page.html?slug=…; edited under Settings → Website.';

insert into public.content_pages (slug, title, body, sort_order) values
  ('about', 'About us',
   'Fresh Supply is a wholesale supplier of fresh produce, dairy, meat, staples, packaging and cleaning supplies for food businesses — restaurants, cloud kitchens, hotels, caterers, institutions and defence messes.\n\n## What we do\n\nOne supplier, one invoice, delivery in the slot you choose. We buy daily from farms, mandis, mills and brand distributors, store perishables cold, and deliver from our own warehouse.\n\n## Where we are\n\nWe currently serve Visakhapatnam and are opening more cities. Register and we will tell you when we reach yours.', 10),
  ('terms', 'Terms of service',
   '## Accounts\n\nAccounts are for food businesses and institutions. We approve each account before the first order and may ask for an FSSAI licence and GST certificate.\n\n## Orders\n\nAn order is confirmed when we accept it. Prices are those shown at the time of ordering; weighed items may vary within the tolerance shown on the product. Minimum quantities and any minimum order value are shown before you place the order.\n\n## Delivery\n\nWe deliver in the slot you choose. Please have someone at the delivery address to receive the goods and give the delivery code.\n\n## Payment\n\nCash on delivery, or credit for approved accounts within the agreed days. Overdue accounts may be put on cash-only terms.\n\n## Returns\n\nSee the Refund policy.', 20),
  ('privacy', 'Privacy policy',
   'We collect the details needed to serve you: business name, address, contact phone and email, GSTIN and FSSAI number, your orders and payments, and — if you choose to share it — your delivery location.\n\n## How we use it\n\nTo deliver orders, raise invoices, send order and payment messages by SMS and email, and support you. We do not sell your data.\n\n## Who sees it\n\nOur team, our delivery staff (address and phone for your deliveries), and the services that run the app (database hosting, SMS and email providers, payment gateway).\n\n## Your choices\n\nYou can update your details under Account, and ask us to close your account at any time.', 30),
  ('refund-policy', 'Refund & return policy',
   '## At the door\n\nCheck your delivery when it arrives. Anything damaged, short or not up to grade can be handed back to the driver and is removed from the invoice.\n\n## After delivery\n\nReport a problem the same day from My orders → Report an issue, or raise a ticket under Help. We replace the item on the next delivery or issue a credit note against your account.\n\n## Refunds\n\nCredit notes are applied to your account balance. Where you have paid in full and no further orders are expected, we refund to the original payment method within 7 working days.', 40);

alter table public.content_pages enable row level security;
create policy content_pages_public_select on public.content_pages for select to anon using (is_published);
create policy content_pages_select on public.content_pages for select to authenticated
  using (is_published or (select public.app_role()) = 'admin');
create policy content_pages_write on public.content_pages for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));
grant select on public.content_pages to anon;
create trigger audit_content_pages after insert or update or delete on public.content_pages for each row execute function public.write_audit_log();

alter table public.company_settings
  add column seo_title       text not null default 'Fresh Supply — All your kitchen needs, delivered',
  add column seo_description text not null default 'Wholesale ingredients, packaging and kitchen essentials for restaurants, cloud kitchens, hotels, caterers and institutions. Next-day and express delivery.';

-- The public site reads name + SEO + support channels in one call (no settings row exposed to anon).
create or replace function public.support_channels()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('phone', support_phone, 'whatsapp', support_whatsapp, 'email', support_email, 'name', name,
                            'address', address, 'gstin', gstin, 'fssai', fssai,
                            'seo_title', seo_title, 'seo_description', seo_description)
  from public.company_settings where id = true;
$$;
