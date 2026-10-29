// =============================================================================
// auth.js — sign-in, sign-up, sign-out and the per-page access guard.
//
// Roles live in the database (profiles.role). The browser can READ its own
// role to decide which screens to show, but it can never CHANGE it — and every
// database call re-checks the role server-side, so hiding a button here is a
// convenience, not the security boundary.
// =============================================================================

import { supabase } from './supabase.js';
import { ROLE_HOME, ROLE_LOGIN, webRoot, MODULES, ACTIONS } from './config.js';
import { toPermissionSet } from './permissions.js';

/** All module:action pairs — granted to super_admin. */
function allPermissions() {
  const entries = [];
  for (const mod of Object.keys(MODULES)) {
    for (const action of Object.keys(ACTIONS)) {
      entries.push({ module: mod, action });
    }
  }
  return toPermissionSet(entries);
}

/** Throw a readable Error if a Supabase call returned one. */
function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/** Log in with email + password. Returns the Supabase session. */
export async function signIn(email, password) {
  const data = check(await supabase.auth.signInWithPassword({ email: email.trim(), password }));
  return data.session;
}

/**
 * Register a new RESTAURANT account. The database trigger handle_new_user()
 * reads these metadata fields and creates the profile + restaurant rows.
 * The role is never taken from here: sign-up always produces a restaurant.
 *
 * Returns { needsEmailConfirmation } — true when Supabase has "Confirm email"
 * switched on and no session was issued yet.
 */
export async function signUpRestaurant({ email, password, fullName, phone, restaurantName, address, gstin, fssai, cityId, pincode, sectorCode, lat, lng }) {
  const data = check(await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        full_name: fullName, phone, restaurant_name: restaurantName, address, gstin, fssai,
        city_id: cityId || null, pincode: pincode || null, sector_code: sectorCode || 'restaurant',
        lat: lat ? Number(lat) : null, lng: lng ? Number(lng) : null,   // map pin from "Use my location" (migration 018)
      },
      emailRedirectTo: `${webRoot}restaurant/login.html`,
    },
  }));
  return { needsEmailConfirmation: !data.session };
}

/** Sign out and return to the login page for `role` (or the public home page). */
/**
 * Create a staff login (used only by the first-admin setup). The database
 * trigger makes every sign-up a restaurant with no restaurant row; the caller
 * then promotes it with claimFirstAdmin().
 */
export async function signUpStaff({ email, password, fullName, phone }) {
  const data = check(await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { full_name: fullName, phone }, emailRedirectTo: `${webRoot}admin/login.html` },
  }));
  return { needsEmailConfirmation: !data.session };
}

export async function signOut(role) {
  await supabase.auth.signOut();
  location.href = role ? loginFor(role) : webRoot;
}

/**
 * Send the sign-up confirmation email again (the first one went to spam, or
 * never arrived). Public: Supabase rate-limits it per address. Returns nothing;
 * the message to the person is the same whether or not the address exists.
 */
export async function resendConfirmation(email) {
  check(await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: `${webRoot}restaurant/login.html` } }));
}

/** Send a password-reset email that returns to reset.html. */
export async function requestPasswordReset(email) {
  check(await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${webRoot}reset.html`,
  }));
}

export async function updatePassword(newPassword) {
  check(await supabase.auth.updateUser({ password: newPassword }));
}

/** The current session, or null. */
export async function getSession() {
  return check(await supabase.auth.getSession()).session;
}

/**
 * Load { user, profile, restaurant, permissions } for the logged-in user.
 * `restaurant` is null for staff. `permissions` is a Set of 'module:action'
 * for admin-app users (empty for everyone else; super admins need none).
 */
export async function loadCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  const { data: profile, error } = await supabase
    .from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) throw new Error(error.message);
  // No readable profile = account deactivated (RLS hides the row).
  if (!profile || !profile.is_active) return { user: session.user, profile: null, restaurant: null, permissions: new Set() };

  let restaurant = null;
  let permissions = new Set();
  if (profile.role === 'restaurant') {
    // The account this login belongs to: the owner's own, or — migration 020 — the one a member was invited to.
    const { data: rid } = await supabase.rpc('my_restaurant_id');
    const res = rid
      ? await supabase.from('restaurants').select('*').eq('id', rid).maybeSingle()
      : await supabase.from('restaurants').select('*').eq('owner_id', profile.id).maybeSingle();
    restaurant = check(res);
  } else if (profile.role === 'admin' && profile.team_role) {
    if (profile.team_role === 'super_admin') {
      permissions = allPermissions();
    } else {
      const rows = check(await supabase.from('role_permissions').select('module, action').eq('team_role', profile.team_role));
      permissions = toPermissionSet(rows);
    }
  }
  return { user: session.user, profile, restaurant, permissions };
}

/** Where a role should land after login. */
export function homeFor(role) {
  return `${webRoot}${ROLE_HOME[role] ?? ''}`;
}

/** The sign-in page for a role. */
export function loginFor(role) {
  return `${webRoot}${ROLE_LOGIN[role] ?? ''}`;
}

/**
 * Call at the top of every protected page.
 *   const me = await requireRole('admin');
 * Redirects to the login page (or to the user's own home if they have the
 * wrong role) and returns null so the caller can stop. Otherwise returns the
 * current user context.
 */
export async function requireRole(role) {
  const me = await loadCurrentUser();
  if (!me) { location.replace(loginFor(role)); return null; }
  if (!me.profile) {
    await supabase.auth.signOut();
    location.replace(`${loginFor(role)}?reason=disabled`);
    return null;
  }
  if (me.profile.role !== role) { location.replace(homeFor(me.profile.role)); return null; }
  return me;
}
