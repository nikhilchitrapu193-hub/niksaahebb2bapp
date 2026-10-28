-- =============================================================================
-- Migration 018: Notifications & support (Phase 1, batch 9).
--
--   * An OUTBOX. Every message the app wants to send is a row in
--     `notifications` (channel sms / email, recipient, body, status). Database
--     triggers queue them — order placed / confirmed / dispatched / delivered /
--     cancelled, receipt recorded, ticket replied — and queue_payment_reminders()
--     adds "due tomorrow" / "overdue" once a day. The send-notifications Edge
--     Function drains the queue through ONE provider interface: SMS via httpSMS
--     (your own Android phone + SIM) or MSG91, email via Resend or Brevo. Which
--     one is an Edge Function secret, not a code change. Nothing here depends on
--     a provider being set: with none, rows stay 'queued' and the admin sees it.
--   * `notification_settings`: per event (and optionally per sector) which
--     channels are on and the template. Placeholders: {customer}, {order},
--     {total}, {amount}, {due_date}, {company}, {ticket}, {status}.
--   * Support tickets: a customer (or staff on their behalf) opens a ticket,
--     optionally about an order; staff with orders:edit reply, assign, resolve.
--   * Help centre: articles the admin edits (settings:edit), read by customers
--     and drivers; the public FAQ reads the same table.
--   * Map pin: restaurants.lat / lng from sign-up ("use my location") or the
--     Account page; drivers get a pin instead of an address search.
--   * Support channels on company_settings (phone, WhatsApp, email) for the
--     call / WhatsApp buttons across the apps.
--
-- Decision records: docs/adr/0022-no-framework-for-phase-2.md,
--                   docs/adr/0023-notification-outbox-and-providers.md
-- =============================================================================

-- ---------- 1. Company support channels and the gateway switch ----------------

alter table public.company_settings
  add column support_phone    text not null default '',
  add column support_whatsapp text not null default '',   -- digits with country code, e.g. 919876543210
  add column support_email    text not null default '',
  add column sms_from_label   text not null default 'Fresh Supply',   -- shown in templates as {company}
  add column notify_customers boolean not null default true;          -- master switch for customer messages
comment on column public.company_settings.notify_customers is
  'Master switch: off = nothing is queued for customers (staff messages still go). The per-event switches are in notification_settings.';

alter table public.restaurants
  add column lat numeric(9,6) check (lat is null or lat between -90 and 90),
  add column lng numeric(9,6) check (lng is null or lng between -180 and 180);
grant update (lat, lng) on public.restaurants to authenticated;   -- customers:edit policy applies

-- ---------- 2. Settings per event ----------------------------------------------

create table public.notification_settings (
  event          text not null check (event in ('order_placed', 'order_confirmed', 'order_out_for_delivery', 'order_delivered',
                                                'order_cancelled', 'receipt_recorded', 'payment_due', 'payment_overdue',
                                                'ticket_reply', 'customer_approved')),
  sector_code    text references public.sectors (code) on delete cascade,   -- NULL = default for every sector
  sms_enabled    boolean not null default true,
  email_enabled  boolean not null default false,
  sms_template   text not null,
  email_subject  text not null default '',
  email_template text not null default '',
  updated_at     timestamptz not null default now()
);
create unique index notification_settings_default_idx on public.notification_settings (event) where sector_code is null;
create unique index notification_settings_sector_idx  on public.notification_settings (event, sector_code) where sector_code is not null;
comment on table public.notification_settings is
  'Which channels each event uses and its wording. A sector row overrides the default row. Placeholders: {customer} {order} {total} {amount} {due_date} {company} {ticket} {status}.';
create trigger notification_settings_set_updated_at before update on public.notification_settings
  for each row execute function public.set_updated_at();

insert into public.notification_settings (event, sms_enabled, email_enabled, sms_template, email_subject, email_template) values
  ('order_placed',           true,  true,  '{company}: order {order} received, total {total}. We will confirm shortly.',
     'Order {order} received', 'Hello {customer},\n\nWe have received your order {order} for {total}. We will confirm it shortly and let you know when it is on its way.\n\n{company}'),
  ('order_confirmed',        true,  false, '{company}: order {order} is confirmed for delivery on {due_date}.',
     'Order {order} confirmed', 'Hello {customer},\n\nYour order {order} is confirmed for delivery on {due_date}.\n\n{company}'),
  ('order_out_for_delivery', true,  false, '{company}: order {order} is on its way. Delivery code: {code}.',
     'Order {order} is on its way', 'Hello {customer},\n\nYour order {order} is out for delivery. Give the driver this code: {code}.\n\n{company}'),
  ('order_delivered',        true,  true,  '{company}: order {order} delivered, {total}. Thank you!',
     'Order {order} delivered', 'Hello {customer},\n\nOrder {order} was delivered. Total {total}. The invoice is in your account.\n\n{company}'),
  ('order_cancelled',        true,  false, '{company}: order {order} has been cancelled.',
     'Order {order} cancelled', 'Hello {customer},\n\nOrder {order} has been cancelled. Reply to this email or call us if that is unexpected.\n\n{company}'),
  ('receipt_recorded',       true,  true,  '{company}: received {amount}, thank you. Receipt {ticket}.',
     'Payment received: {amount}', 'Hello {customer},\n\nWe have received {amount} (receipt {ticket}). Thank you.\n\n{company}'),
  ('payment_due',            true,  true,  '{company}: {amount} for order {order} is due on {due_date}.',
     'Payment due {due_date}: {amount}', 'Hello {customer},\n\n{amount} for order {order} falls due on {due_date}. You can see your account and pay under Payments.\n\n{company}'),
  ('payment_overdue',        true,  true,  '{company}: {amount} for order {order} was due on {due_date}. Please settle it to keep ordering on credit.',
     'Payment overdue: {amount}', 'Hello {customer},\n\n{amount} for order {order} was due on {due_date} and is still open. Please settle it; pay-later orders stay on hold until then.\n\n{company}'),
  ('ticket_reply',           true,  true,  '{company}: we replied to your ticket {ticket}. Open the app to read it.',
     'Reply to your ticket {ticket}', 'Hello {customer},\n\nWe have replied to your support ticket {ticket}:\n\n{status}\n\n{company}'),
  ('customer_approved',      true,  true,  '{company}: your account is approved. You can order now.',
     'Your account is approved', 'Hello {customer},\n\nYour account with {company} is approved. Sign in and place your first order.\n\n{company}');

-- ---------- 3. The outbox ----------------------------------------------------------

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  event         text not null,
  channel       text not null check (channel in ('sms', 'email')),
  restaurant_id uuid references public.restaurants (id) on delete cascade,
  user_id       uuid references public.profiles (id) on delete cascade,     -- a staff recipient (tickets)
  to_address    text not null,                                               -- phone (digits, country code) or email
  subject       text,
  body          text not null,
  order_id      uuid references public.orders (id) on delete set null,
  payment_id    uuid references public.payments (id) on delete set null,
  ticket_id     uuid,                                                        -- fk added after support_tickets exists
  status        text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  provider      text,
  provider_ref  text,
  error         text,
  dedupe_key    text,                                                        -- e.g. payment_due:<order id>; see queue_notification
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index notifications_status_idx on public.notifications (status, created_at);
create index notifications_restaurant_idx on public.notifications (restaurant_id, created_at desc);
create index notifications_order_idx on public.notifications (order_id);
create index notifications_dedupe_idx on public.notifications (restaurant_id, event, dedupe_key, created_at desc) where dedupe_key is not null;
comment on table public.notifications is
  'Every message the app wants to send. Queued by triggers / functions, sent by the send-notifications Edge Function, never deleted.';

-- Fill {placeholders} in a template. Unknown keys stay as typed, so a typo shows up in the log.
create function public.render_template(p_template text, p_values jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce((select string_agg(
            case when m[2] is not null and p_values ? m[2] then p_values ->> m[2] else m[1] end, '' order by ord)
          from regexp_matches(coalesce(p_template, ''), '(\{([a-z_]+)\}|[^{]+|\{)', 'g') with ordinality as t(m, ord)), '');
$$;

-- Normalise an Indian phone to digits with country code (919876543210); null when it is not usable.
create function public.phone_for_sms(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_phone is null then null
    when length(regexp_replace(p_phone, '\D', '', 'g')) = 10 then '91' || regexp_replace(p_phone, '\D', '', 'g')
    when length(regexp_replace(p_phone, '\D', '', 'g')) = 12 and regexp_replace(p_phone, '\D', '', 'g') like '91%' then regexp_replace(p_phone, '\D', '', 'g')
    when length(regexp_replace(p_phone, '\D', '', 'g')) between 11 and 15 then regexp_replace(p_phone, '\D', '', 'g')
    else null end;
$$;

-- Queue the enabled channels of one event for one customer. Internal (no grant):
-- called by triggers and by queue_payment_reminders / tickets. p_values are the
-- placeholders; the function adds {customer} and {company}. Dedupe: p_dedupe_key
-- (e.g. 'payment_due:<order>') skips when an identical key was queued in the
-- last p_dedupe_days days.
create function public.queue_notification(
  p_event         text,
  p_restaurant_id uuid,
  p_values        jsonb default '{}'::jsonb,
  p_order_id      uuid default null,
  p_payment_id    uuid default null,
  p_ticket_id     uuid default null,
  p_dedupe_key    text default null,
  p_dedupe_days   integer default 0
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest    public.restaurants;
  v_company public.company_settings;
  v_cfg     public.notification_settings;
  v_email   text;
  v_phone   text;
  v_vals    jsonb;
  v_n       integer := 0;
begin
  select * into v_company from public.company_settings where id = true;
  if not v_company.notify_customers then return 0; end if;
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then return 0; end if;

  select * into v_cfg from public.notification_settings
  where event = p_event and (sector_code is null or sector_code = v_rest.sector_code)
  order by (sector_code is not null)::int desc limit 1;
  if not found or (not v_cfg.sms_enabled and not v_cfg.email_enabled) then return 0; end if;

  if p_dedupe_key is not null and p_dedupe_days > 0 and exists (
       select 1 from public.notifications n
       where n.restaurant_id = p_restaurant_id and n.event = p_event and n.dedupe_key = p_dedupe_key
         and n.created_at > now() - make_interval(days => p_dedupe_days)) then
    return 0;
  end if;

  select u.email into v_email from auth.users u where u.id = v_rest.owner_id;
  v_phone := public.phone_for_sms(coalesce(v_rest.phone, (select p.phone from public.profiles p where p.id = v_rest.owner_id)));
  v_vals := jsonb_build_object('customer', v_rest.name, 'company', v_company.sms_from_label) || coalesce(p_values, '{}'::jsonb);

  if v_cfg.sms_enabled and v_phone is not null then
    insert into public.notifications (event, channel, restaurant_id, to_address, body, order_id, payment_id, ticket_id, dedupe_key)
    values (p_event, 'sms', p_restaurant_id, v_phone, public.render_template(v_cfg.sms_template, v_vals), p_order_id, p_payment_id, p_ticket_id, p_dedupe_key);
    v_n := v_n + 1;
  end if;
  if v_cfg.email_enabled and v_email is not null then
    insert into public.notifications (event, channel, restaurant_id, to_address, subject, body, order_id, payment_id, ticket_id, dedupe_key)
    values (p_event, 'email', p_restaurant_id, v_email, public.render_template(v_cfg.email_subject, v_vals),
            public.render_template(v_cfg.email_template, v_vals), p_order_id, p_payment_id, p_ticket_id, p_dedupe_key);
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$$;

-- ---------- 4. Triggers that queue messages ----------------------------------------

create function public.notify_order_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text;
  v_vals  jsonb;
begin
  v_event := case new.status
    when 'placed' then 'order_placed'
    when 'confirmed' then 'order_confirmed'
    when 'out_for_delivery' then 'order_out_for_delivery'
    when 'delivered' then 'order_delivered'
    when 'cancelled' then 'order_cancelled'
    else null end;
  if v_event is null then return null; end if;
  -- An insert fires 'placed' only once the totals are in (place_order_core updates them right after).
  if tg_op = 'INSERT' then return null; end if;
  if tg_op = 'UPDATE' and old.status = new.status then
    -- The 'placed' message goes out when the totals land (first update after insert).
    if new.status = 'placed' and old.total_amount = 0 and new.total_amount > 0 then v_event := 'order_placed'; else return null; end if;
  end if;
  v_vals := jsonb_build_object('order', new.order_number, 'total', '₹' || to_char(new.total_amount, 'FM999999990.00'),
                               'due_date', to_char(coalesce(new.delivery_date, (now() at time zone 'Asia/Kolkata')::date), 'DD Mon'),
                               'code', coalesce(new.pod_otp, ''), 'status', new.status::text);
  perform public.queue_notification(v_event, new.restaurant_id, v_vals, new.id, null, null, v_event || ':' || new.id::text, 1);
  return null;
end;
$$;
create trigger orders_notify after update of status, total_amount on public.orders
  for each row execute function public.notify_order_status();

create function public.notify_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.voided_at is not null then return null; end if;
  perform public.queue_notification('receipt_recorded', new.restaurant_id,
    jsonb_build_object('amount', '₹' || to_char(new.amount, 'FM999999990.00'), 'ticket', new.receipt_number), null, new.id, null,
    'receipt:' || new.id::text, 1);
  return null;
end;
$$;
create trigger payments_notify after insert on public.payments for each row execute function public.notify_receipt();

create function public.notify_customer_approved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.queue_notification('customer_approved', new.id, '{}'::jsonb, null, null, null, 'approved:' || new.id::text, 30);
  end if;
  return null;
end;
$$;
create trigger restaurants_notify_approved after update of status on public.restaurants
  for each row execute function public.notify_customer_approved();

-- Payment reminders: run once a day (the Edge Function calls it before draining).
-- Due tomorrow → payment_due once; overdue → payment_overdue at most every 7 days.
create function public.queue_payment_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_o     record;
  v_n     integer := 0;
begin
  for v_o in
    select o.id, o.order_number, o.restaurant_id, o.due_date, o.total_amount - public.allocated_to_order(o.id) as balance
    from public.orders o
    where o.status = 'delivered' and o.payment_method = 'credit' and o.due_date is not null
      and o.total_amount - public.allocated_to_order(o.id) > 0
      and (o.due_date = v_today + 1 or o.due_date < v_today)
  loop
    if v_o.due_date = v_today + 1 then
      v_n := v_n + public.queue_notification('payment_due', v_o.restaurant_id,
        jsonb_build_object('order', v_o.order_number, 'amount', '₹' || to_char(v_o.balance, 'FM999999990.00'), 'due_date', to_char(v_o.due_date, 'DD Mon')),
        v_o.id, null, null, 'payment_due:' || v_o.id::text, 30);
    else
      v_n := v_n + public.queue_notification('payment_overdue', v_o.restaurant_id,
        jsonb_build_object('order', v_o.order_number, 'amount', '₹' || to_char(v_o.balance, 'FM999999990.00'), 'due_date', to_char(v_o.due_date, 'DD Mon')),
        v_o.id, null, null, 'payment_overdue:' || v_o.id::text, 7);
    end if;
  end loop;
  return v_n;
end;
$$;

-- ---------- 5. The sender's two calls (service role only) --------------------------

-- Take up to p_limit queued rows and mark them 'sending'. The Edge Function
-- then reports each one back with mark_notification().
create function public.claim_notifications(p_limit integer default 50)
returns setof public.notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    update public.notifications n
    set status = 'sending', attempts = attempts + 1
    where n.id in (select id from public.notifications where status = 'queued' order by created_at limit greatest(1, least(p_limit, 200)) for update skip locked)
    returning n.*;
end;
$$;

create function public.mark_notification(p_id uuid, p_status text, p_provider text default null, p_provider_ref text default null, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped', 'queued') then raise exception 'Unknown status %', p_status; end if;
  update public.notifications
  set status = p_status, provider = coalesce(p_provider, provider), provider_ref = coalesce(p_provider_ref, provider_ref),
      error = case when p_status = 'sent' then null else coalesce(left(p_error, 500), error) end,
      sent_at = case when p_status = 'sent' then now() else sent_at end
  where id = p_id;
end;
$$;

-- Staff: re-queue a failed row (orders:edit or settings:edit).
create function public.retry_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not ((select public.has_permission('settings', 'edit')) or (select public.has_permission('orders', 'edit'))) then
    raise exception 'You do not have permission to retry messages' using errcode = '42501';
  end if;
  update public.notifications set status = 'queued', error = null where id = p_id and status in ('failed', 'skipped');
end;
$$;

-- ---------- 6. Support tickets ------------------------------------------------------

create sequence public.ticket_number_seq start 1000;

create table public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  ticket_number   text not null unique default ('TKT-' || nextval('public.ticket_number_seq')::text),
  restaurant_id   uuid not null references public.restaurants (id) on delete cascade,
  order_id        uuid references public.orders (id) on delete set null,
  subject         text not null,
  status          text not null default 'open' check (status in ('open', 'waiting_customer', 'resolved', 'closed')),
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  opened_by       uuid references public.profiles (id) on delete set null,
  assigned_to     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index support_tickets_restaurant_idx on public.support_tickets (restaurant_id, created_at desc);
create index support_tickets_status_idx on public.support_tickets (status, last_message_at desc);
create trigger support_tickets_set_updated_at before update on public.support_tickets for each row execute function public.set_updated_at();

create table public.ticket_messages (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.support_tickets (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null,
  is_staff   boolean not null default false,
  body       text not null,
  created_at timestamptz not null default now()
);
create index ticket_messages_ticket_idx on public.ticket_messages (ticket_id, created_at);

alter table public.notifications add constraint notifications_ticket_fk foreign key (ticket_id) references public.support_tickets (id) on delete set null;

-- A customer (own account) or staff with orders:edit (in scope, on the customer's behalf) opens a ticket.
create function public.open_ticket(p_subject text, p_body text, p_order_id uuid default null, p_restaurant_id uuid default null, p_priority text default 'normal')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_role public.user_role := (select public.app_role());
  v_rid  uuid;
  v_rest public.restaurants;
  v_id   uuid;
  v_num  text;
  v_staff boolean := false;
begin
  if v_role = 'restaurant' then
    v_rid := (select public.my_restaurant_id());
  elsif (select public.has_permission('orders', 'edit')) then
    v_rid := p_restaurant_id; v_staff := true;
  end if;
  if v_rid is null then raise exception 'Choose the customer this ticket is for' using errcode = '42501'; end if;
  select * into v_rest from public.restaurants where id = v_rid;
  if not found then raise exception 'Customer not found'; end if;
  if v_staff and not (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    raise exception 'That customer is outside your scope' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_subject, ''))) = 0 then raise exception 'Give the ticket a subject'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'Describe the problem'; end if;
  if p_order_id is not null and not exists (select 1 from public.orders where id = p_order_id and restaurant_id = v_rid) then
    raise exception 'That order does not belong to this customer';
  end if;
  if p_priority not in ('low', 'normal', 'high') then p_priority := 'normal'; end if;

  insert into public.support_tickets (restaurant_id, order_id, subject, priority, opened_by)
  values (v_rid, p_order_id, left(trim(p_subject), 160), p_priority, v_uid)
  returning id, ticket_number into v_id, v_num;
  insert into public.ticket_messages (ticket_id, author_id, is_staff, body) values (v_id, v_uid, v_staff, left(p_body, 4000));
  return jsonb_build_object('id', v_id, 'ticket_number', v_num);
end;
$$;

-- Reply on a ticket: the customer (own) or staff (orders:edit, in scope). A staff
-- reply reopens a waiting ticket as 'waiting_customer' and notifies the customer;
-- a customer reply sets it back to 'open'.
create function public.reply_ticket(p_ticket_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_role public.user_role := (select public.app_role());
  v_t    public.support_tickets;
  v_rest public.restaurants;
  v_staff boolean;
begin
  select * into v_t from public.support_tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ticket not found'; end if;
  select * into v_rest from public.restaurants where id = v_t.restaurant_id;
  if v_role = 'restaurant' and v_t.restaurant_id = (select public.my_restaurant_id()) then
    v_staff := false;
  elsif (select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id)) then
    v_staff := true;
  else
    raise exception 'You cannot reply on this ticket' using errcode = '42501';
  end if;
  if v_t.status = 'closed' then raise exception 'This ticket is closed; open a new one'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'Type a message'; end if;

  insert into public.ticket_messages (ticket_id, author_id, is_staff, body) values (p_ticket_id, v_uid, v_staff, left(p_body, 4000));
  update public.support_tickets
  set last_message_at = now(),
      status = case when v_staff then (case when status = 'resolved' then 'resolved' else 'waiting_customer' end) else 'open' end,
      assigned_to = case when v_staff then coalesce(assigned_to, v_uid) else assigned_to end
  where id = p_ticket_id;
  if v_staff then
    perform public.queue_notification('ticket_reply', v_t.restaurant_id,
      jsonb_build_object('ticket', v_t.ticket_number, 'status', left(p_body, 300)), v_t.order_id, null, p_ticket_id, null, 0);
  end if;
end;
$$;

-- Staff: status / assignment / priority. The customer may close their own ticket.
create function public.set_ticket(p_ticket_id uuid, p_status text default null, p_assigned_to uuid default null, p_priority text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role := (select public.app_role());
  v_t    public.support_tickets;
  v_rest public.restaurants;
begin
  select * into v_t from public.support_tickets where id = p_ticket_id for update;
  if not found then raise exception 'Ticket not found'; end if;
  select * into v_rest from public.restaurants where id = v_t.restaurant_id;
  if v_role = 'restaurant' and v_t.restaurant_id = (select public.my_restaurant_id()) then
    if p_status is distinct from 'closed' or p_assigned_to is not null or p_priority is not null then
      raise exception 'You can only close your own ticket' using errcode = '42501';
    end if;
  elsif not ((select public.has_permission('orders', 'edit')) and (select public.in_my_scope(v_rest.city_id, v_rest.warehouse_id))) then
    raise exception 'You cannot change this ticket' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('open', 'waiting_customer', 'resolved', 'closed') then raise exception 'Unknown status %', p_status; end if;
  if p_priority is not null and p_priority not in ('low', 'normal', 'high') then raise exception 'Unknown priority %', p_priority; end if;
  update public.support_tickets
  set status = coalesce(p_status, status), assigned_to = coalesce(p_assigned_to, assigned_to), priority = coalesce(p_priority, priority)
  where id = p_ticket_id;
end;
$$;

-- ---------- 7. Help centre ----------------------------------------------------------

create table public.help_articles (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9-]+$'),
  title        text not null,
  body         text not null,                         -- plain text; blank lines = paragraphs
  audience     text not null default 'customer' check (audience in ('customer', 'driver', 'all', 'public')),
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  updated_at   timestamptz not null default now()
);
create trigger help_articles_set_updated_at before update on public.help_articles for each row execute function public.set_updated_at();
comment on table public.help_articles is
  'FAQ / help pages. audience public = also shown on the website FAQ; customer / driver = inside that app; all = both apps.';

insert into public.help_articles (slug, title, body, audience, sort_order) values
  ('who-can-order',     'Who can order?',               'Any food business: restaurants, cloud kitchens, cafés, bakeries, hotels, caterers, canteens and unit messes. Home chefs with an FSSAI registration are welcome too.\n\nNew accounts are approved by our team before the first order.', 'public', 10),
  ('minimum-order',     'Is there a minimum order?',    'Each product has its own minimum quantity, shown on the product. Some customer types have a minimum order value; below it a small delivery fee applies — the cart shows it before you place the order.', 'public', 20),
  ('how-to-pay',        'How do I pay?',                'Cash on delivery, or pay later (credit) for approved accounts. Your account page shows what is open and when it is due; you can print a statement for any month.', 'public', 30),
  ('damaged-or-short',  'Something arrived damaged or short', 'Tell the driver at the door — they can take it back and the invoice is corrected on the spot. Later, open the order under My orders and tap Report an issue; we raise a credit note where due.', 'public', 40),
  ('change-my-order',   'Can I change or cancel an order?', 'For a short while after placing it (the order shows how many minutes are left). After that, call us and we will change it for you until it is packed.', 'customer', 50),
  ('gst-invoice',       'Do you provide GST invoices?', 'Yes. Every order has a GST invoice with your GSTIN, under My orders → Invoice.', 'public', 60),
  ('driver-delivery-code', 'The delivery code',          'Every order has a 4-digit code the customer receives. Ask for it at the door and type it in before completing the delivery. Without the code the delivery cannot be completed; call the office.', 'driver', 10),
  ('driver-cash',       'Cash on delivery',             'Collect the amount shown on the order. It is booked to you in the app; hand it over at the end of the day and the office settles it against your name.', 'driver', 20);

-- ---------- 8. RLS, grants, audit -----------------------------------------------------

alter table public.notification_settings enable row level security;
alter table public.notifications         enable row level security;
alter table public.support_tickets       enable row level security;
alter table public.ticket_messages       enable row level security;
alter table public.help_articles         enable row level security;
revoke all on public.notification_settings, public.notifications, public.support_tickets, public.ticket_messages from anon;
revoke all on public.help_articles from anon;

create policy notification_settings_select on public.notification_settings for select to authenticated
  using ((select public.app_role()) = 'admin');
create policy notification_settings_write on public.notification_settings for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));

-- The customer sees their own messages; staff with orders:view / customers:view see customers in scope; settings:view sees all.
create policy notifications_select on public.notifications for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or user_id = (select auth.uid())
         or (select public.has_permission('settings', 'view'))
         or (((select public.has_permission('orders', 'view')) or (select public.has_permission('customers', 'view')))
             and exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))));

create policy support_tickets_select on public.support_tickets for select to authenticated
  using (restaurant_id = (select public.my_restaurant_id())
         or (((select public.has_permission('orders', 'view')) or (select public.has_permission('customers', 'view')))
             and exists (select 1 from public.restaurants r where r.id = restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))));
create policy ticket_messages_select on public.ticket_messages for select to authenticated
  using (exists (select 1 from public.support_tickets t where t.id = ticket_id and (
           t.restaurant_id = (select public.my_restaurant_id())
           or (((select public.has_permission('orders', 'view')) or (select public.has_permission('customers', 'view')))
               and exists (select 1 from public.restaurants r where r.id = t.restaurant_id and (select public.in_my_scope(r.city_id, r.warehouse_id)))))));

-- Help: everyone signed in reads published articles; the public site reads 'public' ones logged out.
create policy help_articles_public_select on public.help_articles for select to anon using (is_published and audience = 'public');
create policy help_articles_select on public.help_articles for select to authenticated
  using (is_published or (select public.app_role()) = 'admin');
create policy help_articles_write on public.help_articles for all to authenticated
  using ((select public.has_permission('settings', 'edit'))) with check ((select public.has_permission('settings', 'edit')));
grant select on public.help_articles to anon;

revoke all on public.notifications, public.support_tickets, public.ticket_messages from authenticated;
grant select on public.notifications, public.support_tickets, public.ticket_messages to authenticated;

create trigger audit_notification_settings after insert or update or delete on public.notification_settings for each row execute function public.write_audit_log();
create trigger audit_support_tickets       after insert or update or delete on public.support_tickets       for each row execute function public.write_audit_log();
create trigger audit_help_articles         after insert or update or delete on public.help_articles         for each row execute function public.write_audit_log();

revoke execute on function public.render_template(text, jsonb)            from public, anon;
grant  execute on function public.render_template(text, jsonb)            to authenticated;   -- the settings screen previews a template
revoke execute on function public.phone_for_sms(text)                      from public, anon, authenticated;
revoke execute on function public.queue_notification(text, uuid, jsonb, uuid, uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.notify_order_status()                    from public, anon, authenticated;
revoke execute on function public.notify_receipt()                         from public, anon, authenticated;
revoke execute on function public.notify_customer_approved()               from public, anon, authenticated;
revoke execute on function public.queue_payment_reminders()                from public, anon, authenticated;
revoke execute on function public.claim_notifications(integer)             from public, anon, authenticated;
revoke execute on function public.mark_notification(uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.queue_payment_reminders()                to service_role;
grant  execute on function public.claim_notifications(integer)             to service_role;
grant  execute on function public.mark_notification(uuid, text, text, text, text) to service_role;
revoke execute on function public.retry_notification(uuid)                 from public, anon;
grant  execute on function public.retry_notification(uuid)                 to authenticated;
revoke execute on function public.open_ticket(text, text, uuid, uuid, text) from public, anon;
revoke execute on function public.reply_ticket(uuid, text)                  from public, anon;
revoke execute on function public.set_ticket(uuid, text, uuid, text)        from public, anon;
grant  execute on function public.open_ticket(text, text, uuid, uuid, text) to authenticated;
grant  execute on function public.reply_ticket(uuid, text)                  to authenticated;
grant  execute on function public.set_ticket(uuid, text, uuid, text)        to authenticated;

-- ---------- 9. Sign-up records the map pin; the account page updates it -------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'restaurant_name', '')), '');
  v_pincode   text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'pincode', '')), '');
  v_city_raw  text := coalesce(new.raw_user_meta_data ->> 'city_id', '');
  v_city      uuid := case when v_city_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_city_raw::uuid end;
  v_sector    text := coalesce(new.raw_user_meta_data ->> 'sector_code', 'restaurant');
  -- Map pin (018): only when both look like numbers in range; a bad value must not break sign-up.
  v_lat       numeric := case when (new.raw_user_meta_data ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' then (new.raw_user_meta_data ->> 'lat')::numeric end;
  v_lng       numeric := case when (new.raw_user_meta_data ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$' then (new.raw_user_meta_data ->> 'lng')::numeric end;
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    'restaurant',
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    left(new.raw_user_meta_data ->> 'phone', 20)
  );

  if v_rest_name is not null then
    if not exists (select 1 from public.sectors where code = v_sector and can_self_register and is_active) then
      v_sector := 'restaurant';
    end if;
    if v_city is null or not exists (select 1 from public.cities where id = v_city and is_active) then
      select id into v_city from public.cities where is_active order by sort_order, name limit 1;
    end if;
    if v_pincode is not null and v_pincode !~ '^[1-9][0-9]{5}$' then v_pincode := null; end if;
    if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 then v_lat := null; v_lng := null; end if;

    insert into public.restaurants (owner_id, name, address, phone, gstin, fssai, sector_code, city_id, pincode, warehouse_id, lat, lng)
    values (
      new.id,
      left(v_rest_name, 120),
      left(coalesce(new.raw_user_meta_data ->> 'address', ''), 400),
      left(new.raw_user_meta_data ->> 'phone', 20),
      left(new.raw_user_meta_data ->> 'gstin', 20),
      left(new.raw_user_meta_data ->> 'fssai', 20),
      v_sector,
      v_city,
      v_pincode,
      public.warehouse_for_pincode(v_pincode),
      v_lat, v_lng
    );
  end if;

  return new;
end;
$$;

-- The customer drops / moves their own pin (null, null clears it).
create function public.update_my_location(p_lat numeric, p_lng numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.app_role()) is distinct from 'restaurant' then
    raise exception 'Only customer accounts can set their location' using errcode = '42501';
  end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'Both latitude and longitude are needed'; end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then raise exception 'That is not a valid location'; end if;
  update public.restaurants set lat = p_lat, lng = p_lng where owner_id = (select auth.uid());
end;
$$;
revoke execute on function public.update_my_location(numeric, numeric) from public, anon;
grant  execute on function public.update_my_location(numeric, numeric) to authenticated;

-- The driver's map pins: lat/lng of the customers whose orders are assigned to
-- the caller. Drivers cannot read restaurants directly (RLS), so this returns
-- only the pin, only for their own active deliveries.
create function public.delivery_pins()
returns table (order_id uuid, lat numeric, lng numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, r.lat, r.lng
  from public.orders o
  join public.restaurants r on r.id = o.restaurant_id
  where o.assigned_to = (select auth.uid())
    and o.status in ('confirmed', 'packed', 'out_for_delivery')
    and r.lat is not null and r.lng is not null;
$$;
revoke execute on function public.delivery_pins() from public, anon;
grant  execute on function public.delivery_pins() to authenticated;

-- ---------- 10. Support-channel columns are readable by every signed-in user --------
-- (company_settings_select already allows that; the public site reads them through
-- support_channels() so the anon role never sees the whole settings row.)
create function public.support_channels()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('phone', support_phone, 'whatsapp', support_whatsapp, 'email', support_email, 'name', name)
  from public.company_settings where id = true;
$$;
grant execute on function public.support_channels() to anon, authenticated;
