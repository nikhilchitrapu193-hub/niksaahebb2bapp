-- =============================================================================
-- Migration 015: Payments & credit (Phase 1, batch 8).
--
--   * Open-item receivables. A DELIVERED order is the invoice (open item); so
--     is a debit note. Money against them comes from receipts (payments) and
--     credit notes (migration 013), linked by payment_allocations. There is no
--     separate ledger table to keep in sync: balances are always computed from
--     these rows, so they cannot drift.
--   * record_payment(): a receipt (cash / UPI / bank / cheque / online / other)
--     allocated to chosen open items, or oldest-due-first when none are given.
--     void_payment() reverses one without deleting anything.
--   * Every paid order has a receipt: when any path marks an order paid a
--     trigger writes the receipt and allocation, so statements are complete.
--     A cash-on-delivery order is cash in hand the moment it is delivered —
--     by the driver's app or from the Orders screen — so it is marked paid
--     (driver_cash + receipt) at delivery; if no cash was collected, finance
--     voids that receipt and the invoice reopens.
--   * Credit notes apply themselves: on insert they go to their own order first,
--     then oldest-due-first. Cash-on-delivery orders are settled at the door and
--     never receive automatic allocations.
--   * Credit limit & days: sectors and customers carry credit_limit (NULL = no
--     limit); orders get a due_date at delivery (credit days from the customer
--     or sector). A credit order is refused when it would exceed the limit or
--     when overdue invoices exist and the sector blocks credit on overdue.
--   * Reports: customer_receivables (one customer), receivables_summary (every
--     customer with 0-30 / 31-60 / 61-90 / 90+ day ageing), customer_statement
--     (a dated statement with running balance). Online (Razorpay) receipts land
--     through record_online_payment(), called only by the webhook Edge Function.
--
-- set_order_payment() (migration 004/006, "mark paid / unpaid") is retired:
-- it changed a flag without a receipt. Kept as set_order_payment_legacy (no DROP).
--
-- Decision record: docs/adr/0019-open-item-receivables.md
-- =============================================================================

-- ---------- 1. Credit terms on sectors and customers -------------------------------

alter table public.sectors
  add column credit_limit              numeric(12,2) check (credit_limit is null or credit_limit >= 0),   -- NULL = no limit
  add column block_credit_when_overdue boolean not null default true;
comment on column public.sectors.credit_limit is 'Default credit limit for customers of this sector; NULL = no limit. A customer row can override.';
comment on column public.sectors.block_credit_when_overdue is 'Refuse pay-later orders while the customer has an overdue invoice.';

alter table public.restaurants
  add column credit_limit numeric(12,2) check (credit_limit is null or credit_limit >= 0);   -- NULL = sector default
grant update (credit_limit) on public.restaurants to authenticated;   -- customers:edit policy applies (migration 006)

alter table public.orders add column due_date date;
comment on column public.orders.due_date is 'Set at delivery: delivered date + credit days for pay-later orders, the delivered date for cash on delivery.';
create index orders_due_idx on public.orders (restaurant_id, due_date) where status = 'delivered';

-- ---------- 2. Receipts, debit notes, allocations ---------------------------------

create sequence public.receipt_number_seq start 1000;
create sequence public.debit_note_number_seq start 1000;

create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  receipt_number text not null unique default ('RCT-' || nextval('public.receipt_number_seq')::text),
  restaurant_id  uuid not null references public.restaurants (id) on delete restrict,
  city_id        uuid not null references public.cities (id) on delete restrict,   -- scope, copied from the customer
  amount         numeric(12,2) not null check (amount > 0),
  method         text not null check (method in ('cash', 'upi', 'bank_transfer', 'cheque', 'online', 'other')),
  reference      text,                       -- UTR, cheque number, gateway payment id
  received_on    date not null default (now() at time zone 'Asia/Kolkata')::date,
  note           text,
  gateway        text,                       -- 'razorpay' for online receipts
  gateway_ref    text,                       -- gateway payment id; unique so a webhook retry cannot double-record
  received_by    uuid references public.profiles (id) on delete set null,
  voided_at      timestamptz,
  void_reason    text,
  voided_by      uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index payments_restaurant_idx on public.payments (restaurant_id, received_on desc);
create unique index payments_gateway_ref_idx on public.payments (gateway, gateway_ref) where gateway_ref is not null;
comment on table public.payments is
  'A receipt from a customer. Voided receipts stay (voided_at set) and count for nothing.';

create table public.debit_notes (
  id                uuid primary key default gen_random_uuid(),
  debit_note_number text not null unique default ('DN-' || nextval('public.debit_note_number_seq')::text),
  restaurant_id     uuid not null references public.restaurants (id) on delete restrict,
  city_id           uuid not null references public.cities (id) on delete restrict,
  order_id          uuid references public.orders (id) on delete set null,
  amount            numeric(12,2) not null check (amount > 0),
  reason            text not null,
  due_date          date not null default (now() at time zone 'Asia/Kolkata')::date,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now()
);
create index debit_notes_restaurant_idx on public.debit_notes (restaurant_id);
comment on table public.debit_notes is 'An extra charge to a customer (crate not returned, late fee…). An open item like a delivered order.';

-- One row links one source of money (a receipt or a credit note) to one open item (a delivered order or a debit note).
create table public.payment_allocations (
  id             uuid primary key default gen_random_uuid(),
  payment_id     uuid references public.payments (id) on delete cascade,
  credit_note_id uuid references public.credit_notes (id) on delete cascade,
  order_id       uuid references public.orders (id) on delete cascade,
  debit_note_id  uuid references public.debit_notes (id) on delete cascade,
  amount         numeric(12,2) not null check (amount > 0),
  created_at     timestamptz not null default now(),
  check (num_nonnulls(payment_id, credit_note_id) = 1),
  check (num_nonnulls(order_id, debit_note_id) = 1)
);
create index payment_allocations_payment_idx on public.payment_allocations (payment_id);
create index payment_allocations_credit_idx  on public.payment_allocations (credit_note_id);
create index payment_allocations_order_idx   on public.payment_allocations (order_id);
create index payment_allocations_debit_idx   on public.payment_allocations (debit_note_id);

-- ---------- 3. Balance helpers (internal: no grants) ------------------------------

-- Money applied to an open item, ignoring voided receipts.
create function public.allocated_to_order(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(a.amount), 0)
  from public.payment_allocations a
  left join public.payments p on p.id = a.payment_id
  where a.order_id = p_order_id and (a.payment_id is null or p.voided_at is null);
$$;

create function public.allocated_to_debit_note(p_debit_note_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(a.amount), 0)
  from public.payment_allocations a
  left join public.payments p on p.id = a.payment_id
  where a.debit_note_id = p_debit_note_id and (a.payment_id is null or p.voided_at is null);
$$;

-- How much of a receipt / credit note is still unapplied.
create function public.payment_unallocated(p_payment_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when p.voided_at is not null then 0
              else p.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.payment_id = p.id), 0) end
  from public.payments p where p.id = p_payment_id;
$$;

create function public.credit_note_unallocated(p_credit_note_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select c.amount - coalesce((select sum(a.amount) from public.payment_allocations a where a.credit_note_id = c.id), 0)
  from public.credit_notes c where c.id = p_credit_note_id;
$$;

-- The customer's position in one object. outstanding = open items minus credit
-- not yet applied (negative = the customer is in credit); overdue = open items
-- past their due date; exposure = outstanding + pay-later orders not yet delivered.
create function public.customer_balance(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_open  numeric := 0; v_overdue numeric := 0; v_open_items int := 0; v_oldest date;
  v_unapplied numeric := 0; v_pending numeric := 0;
begin
  select coalesce(sum(balance), 0), coalesce(sum(balance) filter (where due_date < v_today), 0), count(*),
         min(due_date) filter (where balance > 0)
  into v_open, v_overdue, v_open_items, v_oldest
  from (
    select o.total_amount - public.allocated_to_order(o.id) as balance, o.due_date
    from public.orders o where o.restaurant_id = p_restaurant_id and o.status = 'delivered'
    union all
    select d.amount - public.allocated_to_debit_note(d.id), d.due_date
    from public.debit_notes d where d.restaurant_id = p_restaurant_id
  ) items where balance > 0;

  select coalesce(sum(public.payment_unallocated(p.id)), 0) into v_unapplied
  from public.payments p where p.restaurant_id = p_restaurant_id and p.voided_at is null;
  select v_unapplied + coalesce(sum(public.credit_note_unallocated(c.id)), 0) into v_unapplied
  from public.credit_notes c where c.restaurant_id = p_restaurant_id;

  select coalesce(sum(total_amount), 0) into v_pending
  from public.orders where restaurant_id = p_restaurant_id and payment_method = 'credit' and status not in ('delivered', 'cancelled');

  return jsonb_build_object(
    'outstanding', v_open - v_unapplied, 'overdue', v_overdue, 'open_items', v_open_items,
    'unapplied_credit', v_unapplied, 'pending_credit_orders', v_pending, 'exposure', v_open - v_unapplied + v_pending,
    'oldest_due', v_oldest);
end;
$$;

-- The effective credit limit (customer override, else the sector's; NULL = no limit).
create function public.customer_credit_limit(p_restaurant_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(r.credit_limit, s.credit_limit)
  from public.restaurants r join public.sectors s on s.code = r.sector_code
  where r.id = p_restaurant_id;
$$;

-- Keep orders.payment_status honest: paid when a delivered order is fully covered.
create function public.sync_order_payment_status(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return; end if;
  if v_order.status = 'delivered' and v_order.total_amount - public.allocated_to_order(p_order_id) <= 0 then
    if v_order.payment_status <> 'paid' then
      update public.orders set payment_status = 'paid', paid_at = coalesce(paid_at, now()) where id = p_order_id;
    end if;
  elsif v_order.payment_status = 'paid' then
    update public.orders set payment_status = 'unpaid', paid_at = null where id = p_order_id;
  end if;
end;
$$;

-- Apply every unapplied receipt and credit note of a customer to their open
-- items, oldest due first. A credit note goes to its own order first. Cash-on-
-- delivery orders are settled at the door (their cash receipt is written when
-- they are delivered) and are skipped here; staff can still allocate to one by
-- hand (allocate_payment) after voiding a cash receipt that was never collected.
create function public.allocate_customer_credits(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_src  record;
  v_item record;
  v_left numeric;
  v_take numeric;
begin
  -- One allocation run per customer at a time: two receipts (or a webhook and a
  -- hand-typed receipt) arriving together must not both cover the same invoice.
  perform 1 from public.restaurants where id = p_restaurant_id for update;
  for v_src in
    select 'payment' as kind, p.id, public.payment_unallocated(p.id) as remaining, null::uuid as own_order, p.received_on::timestamptz as ts
    from public.payments p where p.restaurant_id = p_restaurant_id and p.voided_at is null
    union all
    select 'credit_note', c.id, public.credit_note_unallocated(c.id), c.order_id, c.created_at
    from public.credit_notes c where c.restaurant_id = p_restaurant_id
    order by ts, id
  loop
    v_left := v_src.remaining;
    if v_left <= 0 then continue; end if;
    for v_item in
      select * from (
        select 'order' as kind, o.id, o.due_date, o.delivered_at as ts,
               o.total_amount - public.allocated_to_order(o.id) as balance,
               (o.id = v_src.own_order) as own
        from public.orders o
        where o.restaurant_id = p_restaurant_id and o.status = 'delivered' and o.payment_method = 'credit'
        union all
        select 'debit_note', d.id, d.due_date, d.created_at, d.amount - public.allocated_to_debit_note(d.id), false
        from public.debit_notes d where d.restaurant_id = p_restaurant_id
      ) x where balance > 0
      order by own desc, due_date nulls last, ts
    loop
      exit when v_left <= 0;
      v_take := least(v_left, v_item.balance);
      insert into public.payment_allocations (payment_id, credit_note_id, order_id, debit_note_id, amount)
      values (case when v_src.kind = 'payment' then v_src.id end, case when v_src.kind = 'credit_note' then v_src.id end,
              case when v_item.kind = 'order' then v_item.id end, case when v_item.kind = 'debit_note' then v_item.id end, v_take);
      v_left := v_left - v_take;
      if v_item.kind = 'order' then perform public.sync_order_payment_status(v_item.id); end if;
    end loop;
  end loop;
end;
$$;

-- ---------- 4. Triggers: due date at delivery, receipts for paid orders, credit notes apply ---

-- Before an order becomes delivered: stamp delivered_at (some paths leave it) and the due date.
create function public.orders_before_delivered()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_days int;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    new.delivered_at := coalesce(new.delivered_at, now());
    select coalesce(r.credit_days, s.credit_days, 0) into v_days
    from public.restaurants r join public.sectors s on s.code = r.sector_code where r.id = new.restaurant_id;
    new.due_date := (new.delivered_at at time zone 'Asia/Kolkata')::date
                    + case when new.payment_method = 'credit' then coalesce(v_days, 0) else 0 end;
  end if;
  return new;
end;
$$;
create trigger orders_before_delivered before update of status on public.orders
  for each row execute function public.orders_before_delivered();

-- After an order becomes delivered: a cash-on-delivery order is cash in the
-- driver's hand (driver_cash, migration 012) and paid — whichever path delivered
-- it (the driver's complete_delivery or staff's set_order_status); the paid
-- flag then writes the receipt (orders_paid_receipt). If no cash was in fact
-- collected, finance voids that receipt and the invoice reopens. Then any
-- credit the customer already has is applied to pay-later invoices.
create function public.orders_after_delivered()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.payment_method = 'cod' and new.payment_status <> 'paid' and new.total_amount > 0 then
    insert into public.driver_cash (order_id, driver_id, amount)
    values (new.id, coalesce(new.assigned_to, (select auth.uid())), new.total_amount)
    on conflict (order_id) do nothing;
    update public.orders set payment_status = 'paid', paid_at = now() where id = new.id;
  end if;
  perform public.allocate_customer_credits(new.restaurant_id);
  return null;
end;
$$;
create trigger orders_after_delivered after update of status on public.orders
  for each row when (new.status = 'delivered' and old.status is distinct from new.status)
  execute function public.orders_after_delivered();

-- Every paid order has a receipt. complete_delivery (migration 012) marks a COD
-- order paid when the driver collects; this writes the matching receipt.
create function public.orders_paid_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance numeric := new.total_amount - public.allocated_to_order(new.id);
  v_pay uuid;
begin
  if v_balance > 0 then
    insert into public.payments (restaurant_id, city_id, amount, method, note, received_by)
    values (new.restaurant_id, new.city_id, v_balance,
            case when new.payment_method = 'cod' then 'cash' else 'other' end,
            case when new.payment_method = 'cod' then 'Cash on delivery, ' || new.order_number else 'Marked paid, ' || new.order_number end,
            coalesce(new.assigned_to, (select auth.uid())))
    returning id into v_pay;
    insert into public.payment_allocations (payment_id, order_id, amount) values (v_pay, new.id, v_balance);
  end if;
  return null;
end;
$$;
create trigger orders_paid_receipt after update of payment_status on public.orders
  for each row when (new.payment_status = 'paid' and old.payment_status is distinct from 'paid')
  execute function public.orders_paid_receipt();

create function public.credit_notes_apply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.allocate_customer_credits(new.restaurant_id);
  return null;
end;
$$;
create trigger credit_notes_apply after insert on public.credit_notes
  for each row execute function public.credit_notes_apply();

-- ---------- 5. Record, void, debit note ------------------------------------------

-- Apply (part of) a receipt to chosen open items by hand. p_allocations:
-- [{order_id, amount}] / [{debit_note_id, amount}], each ≤ that item's balance,
-- together ≤ what the receipt still has unapplied. A delivered cash-on-delivery
-- order is normally covered by its cash receipt already; when no cash was in
-- fact collected, finance voids that receipt and applies an advance here.
-- payments:edit, in scope.
create function public.allocate_payment(p_payment_id uuid, p_allocations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay   public.payments;
  v_rest  public.restaurants;
  v_line  record;
  v_balance numeric;
  v_left  numeric;
  v_order public.orders;
  v_dn    public.debit_notes;
begin
  if not (select public.has_permission('payments', 'edit')) then
    raise exception 'You do not have permission to allocate payments' using errcode = '42501';
  end if;
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Receipt not found'; end if;
  if v_pay.voided_at is not null then raise exception 'Receipt % is void', v_pay.receipt_number; end if;
  -- Lock the customer (same lock as allocate_customer_credits) so concurrent allocations serialise.
  select * into v_rest from public.restaurants where id = v_pay.restaurant_id for update;
  if not (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    raise exception 'That customer is outside your scope' using errcode = '42501';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Choose at least one invoice or debit note';
  end if;
  v_left := public.payment_unallocated(p_payment_id);

  for v_line in
    select (e ->> 'order_id')::uuid as order_id, (e ->> 'debit_note_id')::uuid as debit_note_id, (e ->> 'amount')::numeric as amount
    from jsonb_array_elements(p_allocations) as e
  loop
    if v_line.amount is null or v_line.amount <= 0 then raise exception 'Each allocation must be more than 0'; end if;
    if v_line.amount > v_left then raise exception 'Allocations add up to more than the receipt has left (%)', v_left; end if;
    if v_line.order_id is not null then
      select * into v_order from public.orders where id = v_line.order_id and restaurant_id = v_pay.restaurant_id and status = 'delivered';
      if not found then raise exception 'That order is not a delivered order of this customer'; end if;
      v_balance := v_order.total_amount - public.allocated_to_order(v_order.id);
      if v_line.amount > v_balance then raise exception 'Order % has only % left to pay', v_order.order_number, v_balance; end if;
      insert into public.payment_allocations (payment_id, order_id, amount) values (p_payment_id, v_order.id, v_line.amount);
      perform public.sync_order_payment_status(v_order.id);
    elsif v_line.debit_note_id is not null then
      select * into v_dn from public.debit_notes where id = v_line.debit_note_id and restaurant_id = v_pay.restaurant_id;
      if not found then raise exception 'That debit note does not belong to this customer'; end if;
      v_balance := v_dn.amount - public.allocated_to_debit_note(v_dn.id);
      if v_line.amount > v_balance then raise exception 'Debit note % has only % left to pay', v_dn.debit_note_number, v_balance; end if;
      insert into public.payment_allocations (payment_id, debit_note_id, amount) values (p_payment_id, v_dn.id, v_line.amount);
    else
      raise exception 'Each allocation names an order or a debit note';
    end if;
    v_left := v_left - v_line.amount;
  end loop;

  return jsonb_build_object('id', p_payment_id, 'receipt_number', v_pay.receipt_number, 'unallocated', v_left);
end;
$$;

-- A receipt (cash / UPI / bank transfer / cheque / online / other). With
-- p_allocations it is applied by hand (allocate_payment); without, oldest due
-- first. Needs payments:edit; the customer must be in the caller's scope.
create function public.record_payment(
  p_restaurant_id uuid,
  p_amount        numeric,
  p_method        text,
  p_reference     text default null,
  p_received_on   date default null,
  p_note          text default null,
  p_allocations   jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest public.restaurants;
  v_pay  uuid;
  v_num  text;
begin
  if not (select public.has_permission('payments', 'edit')) then
    raise exception 'You do not have permission to record payments' using errcode = '42501';
  end if;
  select * into v_rest from public.restaurants where id = p_restaurant_id for update;   -- serialises with the allocator
  if not found then raise exception 'Customer not found'; end if;
  if not (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    raise exception 'That customer is outside your scope' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The amount must be more than 0'; end if;
  if p_method not in ('cash', 'upi', 'bank_transfer', 'cheque', 'online', 'other') then raise exception 'Choose a payment method'; end if;
  if p_method in ('upi', 'bank_transfer', 'cheque') and length(trim(coalesce(p_reference, ''))) = 0 then
    raise exception 'Enter the UTR / transaction or cheque number for a % receipt', replace(p_method, '_', ' ');
  end if;

  insert into public.payments (restaurant_id, city_id, amount, method, reference, received_on, note, received_by)
  values (p_restaurant_id, v_rest.city_id, p_amount, p_method, left(nullif(trim(p_reference), ''), 60),
          coalesce(p_received_on, (now() at time zone 'Asia/Kolkata')::date), left(p_note, 300), (select auth.uid()))
  returning id, receipt_number into v_pay, v_num;

  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0 then
    perform public.allocate_payment(v_pay, p_allocations);
  else
    perform public.allocate_customer_credits(p_restaurant_id);
  end if;

  return jsonb_build_object('id', v_pay, 'receipt_number', v_num, 'amount', p_amount,
                            'unallocated', public.payment_unallocated(v_pay));
end;
$$;

-- Online receipts arrive from the Razorpay webhook Edge Function with the
-- service role (no signed-in user), so this is granted to service_role only.
-- A repeated webhook (same gateway_ref) is ignored, not double-recorded.
create function public.record_online_payment(
  p_restaurant_id uuid,
  p_amount        numeric,
  p_gateway       text,
  p_gateway_ref   text,
  p_received_on   date default null,
  p_note          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest public.restaurants;
  v_pay  uuid;
  v_num  text;
begin
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Customer not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The amount must be more than 0'; end if;
  if length(trim(coalesce(p_gateway_ref, ''))) = 0 then raise exception 'A gateway payment id is required'; end if;
  -- The unique index on (gateway, gateway_ref) makes a webhook retry a no-op even when two arrive together.
  insert into public.payments (restaurant_id, city_id, amount, method, reference, received_on, note, gateway, gateway_ref)
  values (p_restaurant_id, v_rest.city_id, p_amount, 'online', left(p_gateway_ref, 60),
          coalesce(p_received_on, (now() at time zone 'Asia/Kolkata')::date), left(p_note, 300), p_gateway, p_gateway_ref)
  on conflict (gateway, gateway_ref) where gateway_ref is not null do nothing
  returning id, receipt_number into v_pay, v_num;
  if v_pay is null then
    select id, receipt_number into v_pay, v_num from public.payments where gateway = p_gateway and gateway_ref = p_gateway_ref;
    return jsonb_build_object('id', v_pay, 'receipt_number', v_num, 'duplicate', true);
  end if;
  perform public.allocate_customer_credits(p_restaurant_id);
  return jsonb_build_object('id', v_pay, 'receipt_number', v_num, 'duplicate', false);
end;
$$;

-- Reverse a receipt (bounced cheque, typo). payments:approve. Nothing is
-- deleted: the receipt is marked void and its allocations stop counting.
create function public.void_payment(p_payment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay  public.payments;
  v_rest public.restaurants;
  v_oid  uuid;
begin
  if not (select public.has_permission('payments', 'approve')) then
    raise exception 'You do not have permission to void receipts' using errcode = '42501';
  end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  select * into v_rest from public.restaurants where id = v_pay.restaurant_id;
  if not (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    raise exception 'That customer is outside your scope' using errcode = '42501';
  end if;
  if v_pay.voided_at is not null then raise exception 'Receipt % is already void', v_pay.receipt_number; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Give a reason for voiding the receipt'; end if;

  update public.payments set voided_at = now(), void_reason = left(p_reason, 300), voided_by = (select auth.uid())
  where id = p_payment_id;
  for v_oid in select distinct order_id from public.payment_allocations where payment_id = p_payment_id and order_id is not null loop
    perform public.sync_order_payment_status(v_oid);
  end loop;
end;
$$;

-- An extra charge to a customer. payments:edit, in scope.
create function public.raise_debit_note(
  p_restaurant_id uuid,
  p_amount        numeric,
  p_reason        text,
  p_order_id      uuid default null,
  p_due_date      date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest public.restaurants;
  v_id   uuid;
  v_num  text;
begin
  if not (select public.has_permission('payments', 'edit')) then
    raise exception 'You do not have permission to raise debit notes' using errcode = '42501';
  end if;
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Customer not found'; end if;
  if not (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    raise exception 'That customer is outside your scope' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The amount must be more than 0'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Give a reason for the debit note'; end if;
  if p_order_id is not null and not exists (select 1 from public.orders where id = p_order_id and restaurant_id = p_restaurant_id) then
    raise exception 'That order does not belong to this customer';
  end if;

  insert into public.debit_notes (restaurant_id, city_id, order_id, amount, reason, due_date, created_by)
  values (p_restaurant_id, v_rest.city_id, p_order_id, p_amount, left(p_reason, 300),
          coalesce(p_due_date, (now() at time zone 'Asia/Kolkata')::date), (select auth.uid()))
  returning id, debit_note_number into v_id, v_num;
  perform public.allocate_customer_credits(p_restaurant_id);
  return jsonb_build_object('id', v_id, 'debit_note_number', v_num);
end;
$$;

-- ---------- 6. Reports ------------------------------------------------------------

-- One customer: balance, credit limit and every open item with its balance.
-- The customer themselves, or payments:view / customers:view in scope.
create function public.customer_receivables(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rest  public.restaurants;
  v_bal   jsonb;
  v_limit numeric;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Customer not found'; end if;
  if not (v_rest.owner_id = (select auth.uid())
          or (((select public.has_permission('payments', 'view')) or (select public.has_permission('customers', 'view')))
              and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)))) then
    raise exception 'You cannot see this account' using errcode = '42501';
  end if;
  v_bal := public.customer_balance(p_restaurant_id);
  v_limit := public.customer_credit_limit(p_restaurant_id);
  return v_bal || jsonb_build_object(
    'restaurant_id', p_restaurant_id, 'name', v_rest.name,
    'credit_limit', v_limit,
    'credit_available', case when v_limit is null then null else greatest(v_limit - (v_bal ->> 'exposure')::numeric, 0) end,
    'open_items', (select coalesce(jsonb_agg(i order by i.due_date nulls last, i.item_date), '[]'::jsonb) from (
        select 'order' as kind, o.id, o.order_number as number, o.delivered_at::date as item_date, o.due_date,
               o.total_amount as amount, public.allocated_to_order(o.id) as allocated,
               o.total_amount - public.allocated_to_order(o.id) as balance, o.payment_method::text as method,
               greatest(v_today - o.due_date, 0) as days_overdue
        from public.orders o where o.restaurant_id = p_restaurant_id and o.status = 'delivered'
          and o.total_amount - public.allocated_to_order(o.id) > 0
        union all
        select 'debit_note', d.id, d.debit_note_number, d.created_at::date, d.due_date, d.amount,
               public.allocated_to_debit_note(d.id), d.amount - public.allocated_to_debit_note(d.id), d.reason,
               greatest(v_today - d.due_date, 0)
        from public.debit_notes d where d.restaurant_id = p_restaurant_id and d.amount - public.allocated_to_debit_note(d.id) > 0
      ) i),
    'unapplied', (select coalesce(jsonb_agg(u), '[]'::jsonb) from (
        select 'payment' as kind, p.id, p.receipt_number as number, p.received_on as item_date, public.payment_unallocated(p.id) as balance
        from public.payments p where p.restaurant_id = p_restaurant_id and p.voided_at is null and public.payment_unallocated(p.id) > 0
        union all
        select 'credit_note', c.id, c.credit_note_number, c.created_at::date, public.credit_note_unallocated(c.id)
        from public.credit_notes c where c.restaurant_id = p_restaurant_id and public.credit_note_unallocated(c.id) > 0
      ) u));
end;
$$;

-- Every customer in scope with a non-zero position, oldest overdue first, with
-- ageing buckets by days past due. payments:view.
create function public.receivables_summary()
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not (select public.has_permission('payments', 'view')) then
    raise exception 'You do not have permission to see receivables' using errcode = '42501';
  end if;
  return query
    with items as (
      select o.restaurant_id, o.due_date, o.total_amount - public.allocated_to_order(o.id) as balance
      from public.orders o where o.status = 'delivered'
      union all
      select d.restaurant_id, d.due_date, d.amount - public.allocated_to_debit_note(d.id)
      from public.debit_notes d
    ),
    aged as (
      select restaurant_id,
             sum(balance) as open_total,
             sum(balance) filter (where due_date >= v_today) as current_due,
             sum(balance) filter (where v_today - due_date between 1 and 30)  as d1_30,
             sum(balance) filter (where v_today - due_date between 31 and 60) as d31_60,
             sum(balance) filter (where v_today - due_date between 61 and 90) as d61_90,
             sum(balance) filter (where v_today - due_date > 90)              as d90_plus,
             sum(balance) filter (where due_date < v_today) as overdue,
             min(due_date) filter (where balance > 0) as oldest_due,
             count(*) filter (where balance > 0) as open_items
      from items where balance > 0 group by restaurant_id
    ),
    credit as (
      select restaurant_id, sum(u) as unapplied from (
        select p.restaurant_id, public.payment_unallocated(p.id) as u from public.payments p where p.voided_at is null
        union all
        select c.restaurant_id, public.credit_note_unallocated(c.id) from public.credit_notes c
      ) x group by restaurant_id
    )
    select jsonb_build_object(
      'restaurant_id', r.id, 'name', r.name, 'sector_code', r.sector_code, 'city_id', r.city_id, 'phone', r.phone,
      'outstanding', coalesce(a.open_total, 0) - coalesce(c.unapplied, 0),
      'open_items', coalesce(a.open_items, 0),
      'current_due', coalesce(a.current_due, 0), 'd1_30', coalesce(a.d1_30, 0), 'd31_60', coalesce(a.d31_60, 0),
      'd61_90', coalesce(a.d61_90, 0), 'd90_plus', coalesce(a.d90_plus, 0),
      'overdue', coalesce(a.overdue, 0), 'oldest_due', a.oldest_due,
      'unapplied_credit', coalesce(c.unapplied, 0),
      'credit_limit', public.customer_credit_limit(r.id),
      'credit_days', coalesce(r.credit_days, s.credit_days, 0))
    from public.restaurants r
    join public.sectors s on s.code = r.sector_code
    left join aged a on a.restaurant_id = r.id
    left join credit c on c.restaurant_id = r.id
    where (coalesce(a.open_total, 0) <> 0 or coalesce(c.unapplied, 0) <> 0)
      and public.in_my_scope(r.city_id, r.warehouse_id)
    order by coalesce(a.overdue, 0) desc, coalesce(a.open_total, 0) desc;
end;
$$;

-- Every money event of a customer, one row each (internal; the statement reads it).
create function public.statement_events(p_restaurant_id uuid)
returns table (d date, ts timestamptz, kind text, number text, description text, debit numeric, credit numeric, ref_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select (o.delivered_at at time zone 'Asia/Kolkata')::date, o.delivered_at, 'invoice', o.order_number,
         'Order ' || o.order_number || case when o.payment_method = 'credit' then ' (pay later, due ' || to_char(o.due_date, 'DD Mon') || ')' else ' (cash on delivery)' end,
         o.total_amount, 0::numeric, o.id
  from public.orders o where o.restaurant_id = p_restaurant_id and o.status = 'delivered'
  union all
  select d.created_at::date, d.created_at, 'debit_note', d.debit_note_number, 'Debit note: ' || d.reason, d.amount, 0, d.id
  from public.debit_notes d where d.restaurant_id = p_restaurant_id
  union all
  select p.received_on, p.created_at, 'payment', p.receipt_number,
         'Receipt (' || replace(p.method, '_', ' ') || coalesce(', ' || p.reference, '') || ')', 0, p.amount, p.id
  from public.payments p where p.restaurant_id = p_restaurant_id and p.voided_at is null
  union all
  select c.created_at::date, c.created_at, 'credit_note', c.credit_note_number, 'Credit note' || coalesce(': ' || c.reason, ''), 0, c.amount, c.id
  from public.credit_notes c where c.restaurant_id = p_restaurant_id;
$$;

-- A statement for one customer between two dates: opening balance, every
-- invoice / debit note (debit) and receipt / credit note (credit) with a running
-- balance, closing balance. The customer themselves or payments:view in scope.
create function public.customer_statement(p_restaurant_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rest    public.restaurants;
  v_opening numeric := 0;
  v_lines   jsonb;
  v_closing numeric;
begin
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Customer not found'; end if;
  if not (v_rest.owner_id = (select auth.uid())
          or ((select public.has_permission('payments', 'view')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)))) then
    raise exception 'You cannot see this statement' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid date range'; end if;

  select coalesce(sum(debit - credit), 0) into v_opening
  from public.statement_events(p_restaurant_id) where d < p_from;

  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'kind', kind, 'number', number, 'description', description,
                                               'debit', debit, 'credit', credit, 'ref_id', ref_id, 'balance', v_opening + running)
                            order by d, ts, number), '[]'::jsonb)
  into v_lines
  from (select e.*, sum(debit - credit) over (order by d, ts, number rows unbounded preceding) as running
        from public.statement_events(p_restaurant_id) e where d between p_from and p_to) x;

  v_closing := v_opening + coalesce((select sum((l ->> 'debit')::numeric - (l ->> 'credit')::numeric) from jsonb_array_elements(v_lines) l), 0);
  return jsonb_build_object('restaurant_id', p_restaurant_id, 'name', v_rest.name, 'address', v_rest.address, 'gstin', v_rest.gstin,
                            'from', p_from, 'to', p_to, 'opening_balance', v_opening, 'lines', v_lines, 'closing_balance', v_closing);
end;
$$;

-- admin_outstanding_balances keeps its shape (the Customers screen uses it) but
-- now reports the open-item position, not "unpaid orders of any status".
create or replace function public.admin_outstanding_balances()
returns table (restaurant_id uuid, outstanding numeric, unpaid_orders bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, (b ->> 'outstanding')::numeric, (b ->> 'open_items')::bigint
  from public.restaurants r
  cross join lateral public.customer_balance(r.id) as b
  where ((select public.has_permission('customers', 'view')) or (select public.has_permission('payments', 'view')))
    and public.in_my_scope(r.city_id, r.warehouse_id)
    and ((b ->> 'outstanding')::numeric <> 0 or (b ->> 'open_items')::int > 0);
$$;

-- ---------- 7. my_order_terms v3 and place_order_core v8 (credit rules) ------------

create or replace function public.my_order_terms()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rest  public.restaurants;
  v_sec   public.sectors;
  v_bal   jsonb;
  v_limit numeric;
  v_block text;
begin
  select * into v_rest from public.restaurants where owner_id = (select auth.uid());
  if not found then return null; end if;
  select * into v_sec from public.sectors where code = v_rest.sector_code;
  v_bal := public.customer_balance(v_rest.id);
  v_limit := public.customer_credit_limit(v_rest.id);
  if v_sec.block_credit_when_overdue and (v_bal ->> 'overdue')::numeric > 0 then
    v_block := 'You have overdue invoices of ₹' || to_char((v_bal ->> 'overdue')::numeric, 'FM999999990.00') || '. Settle them to order on credit again.';
  elsif v_limit is not null and (v_bal ->> 'exposure')::numeric >= v_limit then
    v_block := 'Your credit limit of ₹' || to_char(v_limit, 'FM999999990.00') || ' is used up. Pay down your balance or choose cash on delivery.';
  end if;
  return jsonb_build_object(
    'min_order_value',        coalesce(v_rest.min_order_value, v_sec.min_order_value, 0),
    'delivery_fee_below_mov', coalesce(v_rest.delivery_fee_below_mov, v_sec.delivery_fee_below_mov, 0),
    'credit_days',            coalesce(v_rest.credit_days, v_sec.credit_days, 0),
    'needs_po_reference',     v_sec.needs_po_reference,
    'sector_name',            v_sec.name,
    'sector_code',            v_sec.code,
    'sector_active',          v_sec.is_active,
    'delivers',               v_rest.warehouse_id is not null,
    'credit_limit',           v_limit,
    'credit_available',       case when v_limit is null then null else greatest(v_limit - (v_bal ->> 'exposure')::numeric, 0) end,
    'outstanding',            (v_bal ->> 'outstanding')::numeric,
    'overdue',                (v_bal ->> 'overdue')::numeric,
    'credit_blocked_reason',  v_block);
end;
$$;

-- Same as migration 014 plus the credit rules after the total is known.
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
  v_bal      jsonb;
  v_limit    numeric;
begin
  if p_restaurant.status <> 'approved' then
    raise exception 'The customer account is not approved (status: %)', p_restaurant.status;
  end if;
  select * into v_sector from public.sectors where code = p_restaurant.sector_code;
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

  -- Credit rule 1 (before any stock moves): overdue invoices block pay-later orders.
  if p_payment_method = 'credit' then
    v_bal := public.customer_balance(p_restaurant.id);
    if v_sector.block_credit_when_overdue and (v_bal ->> 'overdue')::numeric > 0 then
      raise exception 'You have overdue invoices of ₹%. Settle them to order on credit, or choose cash on delivery.', (v_bal ->> 'overdue')::numeric;
    end if;
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

  -- Credit rule 2: the order must fit under the credit limit (exposure counts
  -- open invoices plus pay-later orders not yet delivered). Raising here rolls
  -- back the order and its stock reservations.
  if p_payment_method = 'credit' then
    v_limit := public.customer_credit_limit(p_restaurant.id);
    if v_limit is not null and (v_bal ->> 'exposure')::numeric + v_total > v_limit then
      raise exception 'This order would take your account to ₹% against a credit limit of ₹%. Pay down your balance or choose cash on delivery.',
        (v_bal ->> 'exposure')::numeric + v_total, v_limit;
    end if;
  end if;

  update public.orders set subtotal = v_subtotal, tax_amount = v_tax, delivery_fee = v_fee, total_amount = v_total
  where id = v_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by)
  values (v_order_id, null, 'placed', p_placed_by);

  return jsonb_build_object('id', v_order_id, 'order_number', v_number, 'total_amount', v_total, 'delivery_fee', v_fee);
end;
$$;

-- ---------- 8. Retire set_order_payment (a flag without a receipt) ----------------

alter function public.set_order_payment(uuid, public.payment_status) rename to set_order_payment_legacy;
revoke execute on function public.set_order_payment_legacy(uuid, public.payment_status) from public, anon, authenticated;

-- ---------- 9. Dashboard: receivables tiles --------------------------------------

create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today_start timestamptz :=
    date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not (select public.has_permission('dashboard', 'view')) then
    raise exception 'You do not have permission to see the dashboard' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'orders_today',
      (select count(*) from public.orders where created_at >= v_today_start and public.in_my_scope(city_id, warehouse_id)),
    'revenue_today',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= v_today_start and status <> 'cancelled' and public.in_my_scope(city_id, warehouse_id)),
    'revenue_7d',
      (select coalesce(sum(total_amount), 0) from public.orders
        where created_at >= now() - interval '7 days' and status <> 'cancelled' and public.in_my_scope(city_id, warehouse_id)),
    'pending_restaurants',
      (select count(*) from public.restaurants where status = 'pending' and public.in_my_scope(city_id, warehouse_id)),
    'open_orders_by_status',
      (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
         select status, count(*) as n from public.orders
         where status not in ('delivered', 'cancelled') and public.in_my_scope(city_id, warehouse_id) group by status) s),
    'top_products_30d',
      (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
         select oi.product_name as name,
                sum(oi.quantity) as quantity,
                sum(oi.line_total) as revenue
         from public.order_items oi
         join public.orders o on o.id = oi.order_id
         where o.created_at >= now() - interval '30 days' and o.status <> 'cancelled'
           and public.in_my_scope(o.city_id, o.warehouse_id)
         group by oi.product_name
         order by sum(oi.line_total) desc
         limit 5) t),
    -- Batch 8: open receivables and the overdue part, in scope.
    'receivables_open',
      (select coalesce(sum(o.total_amount - public.allocated_to_order(o.id)), 0) from public.orders o
        where o.status = 'delivered' and public.in_my_scope(o.city_id, o.warehouse_id)
          and o.total_amount - public.allocated_to_order(o.id) > 0),
    'receivables_overdue',
      (select coalesce(sum(o.total_amount - public.allocated_to_order(o.id)), 0) from public.orders o
        where o.status = 'delivered' and o.due_date < v_today and public.in_my_scope(o.city_id, o.warehouse_id)
          and o.total_amount - public.allocated_to_order(o.id) > 0)
  );
end;
$$;

-- ---------- 10. Audit, RLS and grants ----------------------------------------------

create trigger audit_payments            after insert or update or delete on public.payments            for each row execute function public.write_audit_log();
create trigger audit_debit_notes         after insert or update or delete on public.debit_notes         for each row execute function public.write_audit_log();
create trigger audit_payment_allocations after insert or update or delete on public.payment_allocations for each row execute function public.write_audit_log();

alter table public.payments            enable row level security;
alter table public.debit_notes         enable row level security;
alter table public.payment_allocations enable row level security;
revoke all on public.payments, public.debit_notes, public.payment_allocations from anon;

-- The customer sees their own money; finance (payments:view) and customer-facing
-- staff (customers:view) see customers in their scope. Writes only through functions.
create policy payments_select on public.payments for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or (((select public.has_permission('payments', 'view')) or (select public.has_permission('customers', 'view')))
             and exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))));
create policy debit_notes_select on public.debit_notes for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or (((select public.has_permission('payments', 'view')) or (select public.has_permission('customers', 'view')))
             and exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))));
create policy payment_allocations_select on public.payment_allocations for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id and (
                   p.restaurant_id = (select public.my_restaurant_id())
                   or (((select public.has_permission('payments', 'view')) or (select public.has_permission('customers', 'view')))
                       and exists (select 1 from public.restaurants r where r.id = p.restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id))))))
         or exists (select 1 from public.credit_notes c where c.id = credit_note_id and (
                   c.restaurant_id = (select public.my_restaurant_id())
                   or (((select public.has_permission('payments', 'view')) or (select public.has_permission('customers', 'view')))
                       and exists (select 1 from public.restaurants r where r.id = c.restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))))));
revoke all on public.payments, public.debit_notes, public.payment_allocations from authenticated;
grant select on public.payments, public.debit_notes, public.payment_allocations to authenticated;

revoke execute on function public.allocated_to_order(uuid)                 from public, anon, authenticated;
revoke execute on function public.allocated_to_debit_note(uuid)            from public, anon, authenticated;
revoke execute on function public.payment_unallocated(uuid)                from public, anon, authenticated;
revoke execute on function public.credit_note_unallocated(uuid)            from public, anon, authenticated;
revoke execute on function public.customer_balance(uuid)                   from public, anon, authenticated;
revoke execute on function public.customer_credit_limit(uuid)              from public, anon, authenticated;
revoke execute on function public.sync_order_payment_status(uuid)          from public, anon, authenticated;
revoke execute on function public.allocate_customer_credits(uuid)          from public, anon, authenticated;
revoke execute on function public.orders_before_delivered()                from public, anon, authenticated;
revoke execute on function public.orders_after_delivered()                 from public, anon, authenticated;
revoke execute on function public.orders_paid_receipt()                    from public, anon, authenticated;
revoke execute on function public.credit_notes_apply()                     from public, anon, authenticated;
revoke execute on function public.statement_events(uuid)                   from public, anon, authenticated;
revoke execute on function public.record_online_payment(uuid, numeric, text, text, date, text) from public, anon, authenticated;
grant  execute on function public.record_online_payment(uuid, numeric, text, text, date, text) to service_role;

revoke execute on function public.record_payment(uuid, numeric, text, text, date, text, jsonb) from public, anon;
revoke execute on function public.allocate_payment(uuid, jsonb)                         from public, anon;
revoke execute on function public.void_payment(uuid, text)                              from public, anon;
revoke execute on function public.raise_debit_note(uuid, numeric, text, uuid, date)     from public, anon;
revoke execute on function public.customer_receivables(uuid)                            from public, anon;
revoke execute on function public.receivables_summary()                                 from public, anon;
revoke execute on function public.customer_statement(uuid, date, date)                  from public, anon;
grant  execute on function public.record_payment(uuid, numeric, text, text, date, text, jsonb) to authenticated;
grant  execute on function public.allocate_payment(uuid, jsonb)                         to authenticated;
grant  execute on function public.void_payment(uuid, text)                              to authenticated;
grant  execute on function public.raise_debit_note(uuid, numeric, text, uuid, date)     to authenticated;
grant  execute on function public.customer_receivables(uuid)                            to authenticated;
grant  execute on function public.receivables_summary()                                 to authenticated;
grant  execute on function public.customer_statement(uuid, date, date)                  to authenticated;

-- ---------- 11. Backfill: orders delivered before this migration -----------------------

-- Due dates for already-delivered orders, and a receipt for every one already
-- marked paid (so statements and ageing start complete). Done row by row with
-- a WHERE so nothing is touched twice.
do $$
declare
  v_o record;
  v_pay uuid;
begin
  for v_o in
    select o.*, coalesce(r.credit_days, s.credit_days, 0) as days
    from public.orders o join public.restaurants r on r.id = o.restaurant_id join public.sectors s on s.code = r.sector_code
    where o.status = 'delivered' and o.due_date is null
  loop
    update public.orders
    set delivered_at = coalesce(v_o.delivered_at, v_o.updated_at),
        due_date = (coalesce(v_o.delivered_at, v_o.updated_at) at time zone 'Asia/Kolkata')::date
                   + case when v_o.payment_method = 'credit' then v_o.days else 0 end
    where id = v_o.id;
    -- Already marked paid → a receipt for it. A delivered cash-on-delivery order
    -- never marked paid (delivered from the Orders screen) → cash was collected at
    -- the door: driver cash + receipt, same as the trigger does from now on.
    if v_o.total_amount > 0 and (v_o.payment_status = 'paid' or v_o.payment_method = 'cod') then
      if v_o.payment_status <> 'paid' and v_o.assigned_to is not null then
        insert into public.driver_cash (order_id, driver_id, amount) values (v_o.id, v_o.assigned_to, v_o.total_amount)
        on conflict (order_id) do nothing;
      end if;
      insert into public.payments (restaurant_id, city_id, amount, method, received_on, note, received_by)
      values (v_o.restaurant_id, v_o.city_id, v_o.total_amount, case when v_o.payment_method = 'cod' then 'cash' else 'other' end,
              (coalesce(v_o.paid_at, v_o.delivered_at, v_o.updated_at) at time zone 'Asia/Kolkata')::date,
              case when v_o.payment_status = 'paid' then 'Paid before migration 015, ' else 'Cash on delivery before migration 015, ' end || v_o.order_number, v_o.assigned_to)
      returning id into v_pay;
      insert into public.payment_allocations (payment_id, order_id, amount) values (v_pay, v_o.id, v_o.total_amount);
      if v_o.payment_status <> 'paid' then
        update public.orders set payment_status = 'paid', paid_at = coalesce(v_o.delivered_at, v_o.updated_at) where id = v_o.id;
      end if;
    end if;
  end loop;
end $$;
