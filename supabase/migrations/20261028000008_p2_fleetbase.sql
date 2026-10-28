-- =============================================================================
-- P2-8: Fleetbase Fleet Dispatch Integration
-- =============================================================================

-- Trips linked to Fleetbase orders
create table if not exists fleet_trips (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  driver_id           uuid references profiles(id) on delete set null,
  fleetbase_trip_id   text unique,   -- Fleetbase's UUID for the trip
  fleetbase_order_id  text,          -- Fleetbase internal order UUID
  status              text not null default 'pending'
                        check (status in ('pending','dispatched','en_route','arrived','delivered','completed','cancelled')),
  dispatch_payload    jsonb,         -- full payload sent to Fleetbase (for debugging)
  webhook_events      jsonb default '[]'::jsonb,  -- inbound events from webhook
  dispatched_at       timestamptz,
  completed_at        timestamptz,
  cancelled_reason    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table fleet_trips enable row level security;
create policy "admin manage fleet_trips"    on fleet_trips for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "delivery view fleet_trips"   on fleet_trips for select using (exists (select 1 from profiles where id = auth.uid() and role in ('delivery','admin')));

-- Fleetbase webhook secrets (store in secrets, not here — this is just a marker table for audit)
create table if not exists fleetbase_config (
  id                  uuid primary key default gen_random_uuid(),
  fleet_name          text,
  api_url             text,
  webhook_secret_hint text,          -- last 4 chars only, for verification
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);
alter table fleetbase_config enable row level security;
create policy "admin manage fb_config" on fleetbase_config for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- Update trip status from webhook event
create or replace function apply_fleetbase_event(p_trip_id text, p_status text, p_event jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  new_status text;
begin
  new_status := case p_status
    when 'dispatched'  then 'dispatched'
    when 'en_route'    then 'en_route'
    when 'arrived'     then 'arrived'
    when 'delivered'   then 'delivered'
    when 'completed'   then 'completed'
    when 'cancelled'   then 'cancelled'
    else null
  end;
  if new_status is null then return; end if;

  update fleet_trips
  set    status        = new_status,
         webhook_events = webhook_events || jsonb_build_array(p_event),
         completed_at   = case when new_status in ('completed','delivered') then now() else completed_at end,
         updated_at     = now()
  where  fleetbase_trip_id = p_trip_id;

  -- Sync order status when Fleetbase says delivered
  if new_status in ('delivered','completed') then
    update orders set status = 'delivered', updated_at = now()
    where  id = (select order_id from fleet_trips where fleetbase_trip_id = p_trip_id);
  end if;
end;
$$;
grant execute on function apply_fleetbase_event(text,text,jsonb) to service_role;

create index if not exists idx_fleet_trips_order      on fleet_trips(order_id);
create index if not exists idx_fleet_trips_driver     on fleet_trips(driver_id);
create index if not exists idx_fleet_trips_fb_id      on fleet_trips(fleetbase_trip_id);
create index if not exists idx_fleet_trips_status     on fleet_trips(status);
