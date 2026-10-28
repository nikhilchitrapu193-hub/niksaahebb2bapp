// =============================================================================
// permissions.js — "may this user do that?" for the admin app's menus and
// buttons. Pure functions, no DOM, no network.
//
// The database is the real gatekeeper (has_permission() in migration 006);
// these helpers only decide what to SHOW. `me.permissions` is a Set of
// 'module:action' strings loaded by auth.loadCurrentUser() for admin users.
// =============================================================================

import { MODULES } from './config.js';

/** True when `me` may perform `action` in `module`. Super admins may do everything. */
export function can(me, module, action) {
  if (!me?.profile || me.profile.role !== 'admin') return false;
  if (me.profile.team_role === 'super_admin') return true;
  return me.permissions?.has(`${module}:${action}`) ?? false;
}

/**
 * Admin nav links for the modules `me` may view, in MODULES order.
 * `hidden` = modules switched off under Settings → Launch (launch.js hiddenModules).
 */
export function visibleNav(me, hidden = new Set()) {
  return Object.entries(MODULES)
    .filter(([code, m]) => m.nav && can(me, code, 'view') && !hidden.has(code))
    .map(([, m]) => ({ href: m.nav, label: m.label }));
}

/** Turn role_permissions rows [{module, action}] into the Set `can()` reads. */
export function toPermissionSet(rows) {
  return new Set((rows ?? []).map((r) => `${r.module}:${r.action}`));
}
