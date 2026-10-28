-- =============================================================================
-- Migration 016: Customer access — sign-up must never dead-end on an email.
--
-- A new customer confirms their email before they can sign in. When that email
-- does not arrive (spam folder, a rate-limited mailer, a typo) the customer is
-- stuck and the admin could not see why. This migration gives the Customers
-- screen the login state of every customer (email, confirmed or not, last
-- sign-in), so staff can act with the customer-access Edge Function: confirm the
-- email on the spot, resend the confirmation, hand over a password link, or set
-- a temporary password. The login page itself gets a "Resend confirmation"
-- button (supabase-js auth.resend, no migration needed).
--
-- Decision record: docs/adr/0020-customer-access-never-stuck.md
-- =============================================================================

-- Login state per customer in the caller's scope. customers:view.
-- Reads auth.users (security definer, as admin_list_users does since 006).
create function public.admin_customer_logins()
returns table (
  restaurant_id        uuid,
  owner_id             uuid,
  email                text,
  email_confirmed      boolean,
  confirmation_sent_at timestamptz,
  last_sign_in_at      timestamptz,
  user_created_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.has_permission('customers', 'view')) then
    raise exception 'You do not have permission to see customers' using errcode = '42501';
  end if;
  return query
  select r.id, r.owner_id, u.email::text, u.email_confirmed_at is not null, u.confirmation_sent_at, u.last_sign_in_at, u.created_at
  from public.restaurants r
  join auth.users u on u.id = r.owner_id
  where public.in_my_scope(r.city_id, r.warehouse_id);
end;
$$;

revoke execute on function public.admin_customer_logins() from public, anon;
grant  execute on function public.admin_customer_logins() to authenticated;

-- The Edge Function writes one audit row per action it takes on a login
-- (table 'auth.users', action 'update', changes {customer_access: …}). It uses
-- the service role, which already may insert; nothing to grant here. The row
-- shows on Audit log like any other change, with the staff member as changed_by.
