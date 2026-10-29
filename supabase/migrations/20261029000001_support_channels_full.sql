-- =============================================================================
-- 20261029000001_support_channels_full.sql
--
-- Expand support_channels() to include address, fssai and gstin so the public
-- page footer (page.js fillFooter) can show the company's legal details without
-- needing a second query. The old function is preserved as
-- support_channels_legacy() per the project's "no drop" rule.
-- =============================================================================

-- Keep the old version under a legacy name; do not drop it.
create or replace function public.support_channels_legacy()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'phone',     support_phone,
    'whatsapp',  support_whatsapp,
    'email',     support_email,
    'name',      name
  )
  from public.company_settings where id = true;
$$;
grant execute on function public.support_channels_legacy() to anon, authenticated;

-- Replace the live function with the expanded version.
create or replace function public.support_channels()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'name',     name,
    'phone',    support_phone,
    'whatsapp', support_whatsapp,
    'email',    support_email,
    'address',  address,
    'fssai',    fssai,
    'gstin',    gstin
  )
  from public.company_settings where id = true;
$$;
grant execute on function public.support_channels() to anon, authenticated;
