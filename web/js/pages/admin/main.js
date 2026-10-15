// =============================================================================
// main.js — admin app entry. Routes:
//   #dashboard (default) · #orders · #products · #inventory · #customers · #team
//   #settings (company) · #locations · #sectors · #roles · #audit
//
// The menu shows only the modules the signed-in team member may VIEW
// (web/js/core/permissions.js). Opening a route by hand without permission
// shows a friendly "no access" page; the database refuses the data anyway.
// =============================================================================

import { requireRole } from '../../core/auth.js';
import { renderShell, startRouter } from '../../core/shell.js';
import { $, html, mount } from '../../core/ui.js';
import { getDashboardStats } from '../../core/api.js';
import { can, visibleNav } from '../../core/permissions.js';
import { renderDashboard } from './dashboard.js';
import { renderOrders } from './orders.js';
import { renderProducts } from './products.js';
import { renderCustomers } from './customers.js';
import { renderTeam } from './team.js';
import { renderInventory } from './inventory.js';
import { renderSettings } from './settings.js';
import { renderLocations } from './locations.js';
import { renderSectors } from './sectors.js';
import { renderRoles } from './roles.js';
import { renderAudit } from './audit.js';

/** Sub-pages of Settings keep the Settings menu item highlighted. */
const SETTINGS_ROUTES = new Set(['#locations', '#sectors', '#roles']);

const me = await requireRole('admin');
if (me) {
  const shell = renderShell({ me, subtitle: 'Admin', links: visibleNav(me) });

  // Show the number of customers waiting for approval on the Customers tab.
  if (can(me, 'customers', 'view')) {
    getDashboardStats().then((s) => shell.setBadge('#customers', s.pending_restaurants)).catch(() => {});
  }

  /** Wrap a screen so it only renders when `me` may view `module`. */
  const guard = (module, render) => (container) => {
    if (!can(me, module, 'view')) {
      mount(container, html`<div class="empty"><strong>No access</strong>Your team role does not include ${module}. Ask a super admin.</div>`);
      return;
    }
    return render(container);
  };

  startRouter({
    container: $('#view'),
    fallback: can(me, 'dashboard', 'view') ? '#dashboard' : (visibleNav(me)[0]?.href ?? '#dashboard'),
    onRoute: (key) => shell.setActive(SETTINGS_ROUTES.has(key) ? '#settings' : key),
    routes: {
      '#dashboard': guard('dashboard', renderDashboard),
      '#orders':    guard('orders', (c) => renderOrders(c, me)),
      '#products':  guard('products', (c) => renderProducts(c, me)),
      '#inventory': guard('inventory', (c) => renderInventory(c, me)),
      '#customers': guard('customers', (c) => renderCustomers(c, me, (count) => shell.setBadge('#customers', count))),
      '#team':      guard('team', (c) => renderTeam(c, me)),
      '#settings':  guard('settings', (c) => renderSettings(c, me)),
      '#locations': guard('settings', (c) => renderLocations(c, me)),
      '#sectors':   guard('settings', (c) => renderSectors(c, me)),
      '#roles':     guard('team', (c) => renderRoles(c, me)),
      '#audit':     guard('audit', (c) => renderAudit(c, me)),
    },
  });
}
