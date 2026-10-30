-- =============================================================================
-- Migration 023: Delivery photo infrastructure
--
-- Every trip now carries TWO mandatory photos:
--   1. Pre-departure (loading) photo — taken by the driver at the warehouse
--      before leaving with the PO items. Stored on the trip row so admin can
--      verify the vehicle was loaded correctly and spot any mismatch.
--   2. POD (proof-of-delivery) photo — taken at the customer's door after drop.
--      Already on the order row (photo_path on orders, added in migration 012).
--
-- New bucket: trip-photos (private, max 10 MB per file).
-- New function: record_trip_departure() — driver uploads photo before deliveries.
-- =============================================================================

-- 1. Pre-departure photo columns on trips ------------------------------------
alter table public.trips
  add column if not exists pre_departure_photo_path text,
  add column if not exists pre_departure_at          timestamptz;

comment on column public.trips.pre_departure_photo_path is
  'Storage path in trip-photos bucket. Driver uploads before leaving the warehouse.';
comment on column public.trips.pre_departure_at is
  'When the pre-departure photo was uploaded.';

-- 2. Function: record the loading photo on a dispatched trip -----------------
-- Called by the driver (or fulfilment:edit staff) from the delivery app.
-- The audit_trips trigger fires automatically on the UPDATE.
create or replace function public.record_trip_departure(
  p_trip_id    uuid,
  p_photo_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips;
begin
  select * into v_trip from public.trips where id = p_trip_id;
  if not found then raise exception 'Trip not found'; end if;

  -- Access: the assigned driver OR staff with fulfilment:edit
  if not (
    v_trip.driver_id = (select auth.uid())
    or (select public.has_permission('fulfilment', 'edit'))
  ) then
    raise exception 'Access denied';
  end if;

  if v_trip.status <> 'dispatched' then
    raise exception 'Trip is not dispatched (current status: %)', v_trip.status;
  end if;

  if nullif(trim(coalesce(p_photo_path, '')), '') is null then
    raise exception 'A photo path is required';
  end if;

  -- The audit_trips trigger fires automatically on this UPDATE
  update public.trips
  set
    pre_departure_photo_path = p_photo_path,
    pre_departure_at         = now()
  where id = p_trip_id;
end;
$$;

comment on function public.record_trip_departure(uuid, text) is
  'Driver uploads a photo of the loaded vehicle at the warehouse before leaving. Requires dispatched status.';

-- 3. Private storage bucket for trip loading photos --------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'trip-photos',
  'trip-photos',
  false,
  10485760,   -- 10 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy "delivery staff can upload trip photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'trip-photos'
    and (
      (select public.app_role()) = 'delivery'
      or (select public.has_permission('fulfilment', 'edit'))
    )
  );

create policy "admin and delivery can read trip photos"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'trip-photos'
    and (select public.app_role()) in ('admin', 'delivery')
  );
