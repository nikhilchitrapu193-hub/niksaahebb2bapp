-- =============================================================================
-- P2-6: Finance Reports
-- =============================================================================

-- Finance summary function (admin)
create or replace function finance_summary(p_from date default date_trunc('month',current_date)::date, p_to date default current_date)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select jsonb_build_object(
    'gmv',           coalesce(sum(o.total_amount),0),
    'orders',        count(*),
    'avg_order',     coalesce(avg(o.total_amount),0),
    'paid_amount',   coalesce((select sum(amount) from payments where payment_date between p_from and p_to and status='confirmed'),0),
    'outstanding',   coalesce((select sum(amount_due) from (
                        select r.id, greatest(0, sum(o2.total_amount) - coalesce(sum(pay.amount),0)) as amount_due
                        from   restaurants r
                        join   orders o2 on o2.restaurant_id = r.id and o2.payment_method='credit' and o2.status != 'cancelled'
                        left   join payments pay on pay.restaurant_id = r.id and pay.status='confirmed'
                        where  o2.created_at::date between p_from and p_to
                        group  by r.id
                     ) x where amount_due > 0),0),
    'from', p_from, 'to', p_to
  )
  from orders o
  where o.created_at::date between p_from and p_to
    and o.status != 'cancelled';
$$;
grant execute on function finance_summary(date,date) to authenticated;

-- Category mix (share of revenue by category)
create or replace function category_mix(p_from date default date_trunc('month',current_date)::date, p_to date default current_date)
returns table (category_id uuid, category_name text, revenue numeric, pct numeric)
language sql stable security definer
set search_path = public
as $$
  with base as (
    select c.id, c.name, coalesce(sum(oi.qty * oi.unit_price),0) as rev
    from   categories c
    join   products p  on p.category_id = c.id
    join   order_items oi on oi.product_id = p.id
    join   orders o on o.id = oi.order_id and o.created_at::date between p_from and p_to and o.status != 'cancelled'
    group  by c.id, c.name
  ), total as (select sum(rev) as t from base)
  select b.id, b.name, b.rev, round(b.rev / nullif(t.t,0) * 100, 1)
  from   base b, total t
  order  by b.rev desc;
$$;
grant execute on function category_mix(date,date) to authenticated;

-- Restaurant spend report (for the calling restaurant)
create or replace function my_spend_report(p_from date default date_trunc('month',current_date)::date, p_to date default current_date)
returns table (period text, orders bigint, total numeric)
language sql stable security definer
set search_path = public
as $$
  select to_char(o.created_at,'YYYY-MM-DD') as period,
         count(*)::bigint,
         sum(o.total_amount)
  from   orders o
  where  o.restaurant_id = (select restaurant_id from profiles where id = auth.uid())
    and  o.created_at::date between p_from and p_to
    and  o.status != 'cancelled'
  group  by 1 order by 1;
$$;
grant execute on function my_spend_report(date,date) to authenticated;

-- Revenue by sector (admin)
create or replace function revenue_by_sector(p_from date default date_trunc('month',current_date)::date, p_to date default current_date)
returns table (sector_id uuid, sector_name text, orders bigint, revenue numeric)
language sql stable security definer
set search_path = public
as $$
  select s.id, s.name, count(o.id)::bigint, coalesce(sum(o.total_amount),0)
  from   sectors s
  join   restaurants r on r.sector_id = s.id
  join   orders o on o.restaurant_id = r.id
    and  o.created_at::date between p_from and p_to
    and  o.status != 'cancelled'
  group  by s.id, s.name
  order  by 4 desc;
$$;
grant execute on function revenue_by_sector(date,date) to authenticated;

-- Revenue by day (time series)
create or replace function revenue_by_day(p_from date default current_date - 29, p_to date default current_date)
returns table (day date, orders bigint, revenue numeric)
language sql stable security definer
set search_path = public
as $$
  select o.created_at::date, count(*)::bigint, sum(o.total_amount)
  from   orders o
  where  o.created_at::date between p_from and p_to
    and  o.status != 'cancelled'
  group  by 1 order by 1;
$$;
grant execute on function revenue_by_day(date,date) to authenticated;
