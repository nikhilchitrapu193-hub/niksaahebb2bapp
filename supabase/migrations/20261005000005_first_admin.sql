-- =============================================================================
-- Migration 005 — Self-service bootstrap of the FIRST admin
--
-- There is deliberately no public "register as admin". Instead, the first
-- signed-in user who asks becomes admin, but only while the system has no
-- admin at all. Once one exists this function always returns false, so it
-- cannot be used to escalate later. Further admins are promoted by an admin
-- (Team screen) after being invited or added in the Supabase dashboard.
-- =============================================================================

create function public.claim_first_admin()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Serialise: two people clicking at once must not both become admin.
  perform pg_advisory_xact_lock(hashtext('claim_first_admin'));

  if exists (select 1 from public.profiles where role = 'admin') then
    return false;
  end if;

  update public.profiles set role = 'admin', is_active = true where id = v_uid;
  return found;
end;
$$;

revoke execute on function public.claim_first_admin() from public, anon;
grant execute on function public.claim_first_admin() to authenticated;
