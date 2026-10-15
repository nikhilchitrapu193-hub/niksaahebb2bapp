// =============================================================================
// main.js — admin app entry. Routes:
//   #dashboard (default) · #orders · #products · #inventory · #customers · #team
//   #settings (company) · #locations · #sectors · #roles · #audit
//   #pricing (price board) · #pricing-rules · #benchmarks · #price-lists
//   #procurement (buying list) · #purchase-orders · #receipts · #rate-cards
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
import { renderPriceBoard } from './price-board.js';
import { renderPricingRules } from './pricing-rules.js';
import { renderBenchmarks } from './benchmarks.js';
import { renderPriceLists } from './price-lists.js';
import { renderBuyingList } from './buying-list.js';
import { renderPurchaseOrders } from './purchase-orders.js';
import { renderReceipts } from './grn.js';
import { renderRateCards } from './rate-cards.js';

/** Sub-pages keep their parent menu item highlighted. */
const PARENT_OF = { '#locations': '#settings', '#sectors': '#settings', '#roles': '#settings',
                    '#pricing-rules': '#pricing', '#benchmarks': '#pricing', '#price-lists': '#pricing',
                    '#purchase-orders': '#procurement', '#receipts': '#procurement', '#rate-cards': '#procurement' };

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
    onRoute: (key) => shell.setActive(PARENT_OF[key] ?? key),
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
      '#pricing':   guard('pricing', (c) => renderPriceBoard(c, me)),
      '#pricing-rules': guard('pricing', (c) => renderPricingRules(c, me)),
      '#benchmarks': guard('pricing', (c) => renderBenchmarks(c, me)),
      '#price-lists': guard('pricing', (c) => renderPriceLists(c, me)),
      '#procurement': guard('procurement', (c) => renderBuyingList(c, me)),
      '#purchase-orders': guard('procurement', (c) => renderPurchaseOrders(c, me)),
      '#receipts': guard('procurement', (c) => renderReceipts(c, me)),
      '#rate-cards': guard('procurement', (c) => renderRateCards(c, me)),
    },
  });
}
