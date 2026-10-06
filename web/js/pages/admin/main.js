// =============================================================================
// main.js — admin app entry. Routes:
//   #dashboard (default) · #orders · #products · #inventory · #customers · #team · #settings
// =============================================================================

import { requireRole } from '../../core/auth.js';
import { renderShell, startRouter } from '../../core/shell.js';
import { $ } from '../../core/ui.js';
import { getDashboardStats } from '../../core/api.js';
import { renderDashboard } from './dashboard.js';
import { renderOrders } from './orders.js';
import { renderProducts } from './products.js';
import { renderCustomers } from './customers.js';
import { renderTeam } from './team.js';
import { renderInventory } from './inventory.js';
import { renderSettings } from './settings.js';

const me = await requireRole('admin');
if (me) {
  const shell = renderShell({
    me,
    subtitle: 'Admin',
    links: [
      { href: '#dashboard', label: 'Dashboard' },
      { href: '#orders', label: 'Orders' },
      { href: '#products', label: 'Products' },
      { href: '#inventory', label: 'Inventory' },
      { href: '#customers', label: 'Customers' },
      { href: '#team', label: 'Team' },
      { href: '#settings', label: 'Settings' },
    ],
  });

  // Show the number of restaurants waiting for approval on the Customers tab.
  getDashboardStats().then((s) => shell.setBadge('#customers', s.pending_restaurants)).catch(() => {});

  startRouter({
    container: $('#view'),
    fallback: '#dashboard',
    onRoute: (key) => shell.setActive(key),
    routes: {
      '#dashboard': renderDashboard,
      '#orders': renderOrders,
      '#products': renderProducts,
      '#inventory': renderInventory,
      '#settings': renderSettings,
      '#customers': (c) => renderCustomers(c, (count) => shell.setBadge('#customers', count)),
      '#team': (c) => renderTeam(c, me),
    },
  });
}
