// =============================================================================
// main.js — admin app entry. Routes:
//   #dashboard (default) · #orders · #products · #inventory · #customers · #team
//   #settings (company) · #launch · #locations · #sectors · #roles · #audit
//   #pricing (price board) · #pricing-rules · #benchmarks · #price-lists
//   #procurement (buying list) · #purchase-orders · #receipts · #rate-cards
//   #payments (receivables) · #payments-receipts
//   #notifications · #help-centre · #website · #coupons (settings) · #tickets · #quotes (orders) · #reports
//
// The menu shows only the modules the signed-in team member may VIEW
// (web/js/core/permissions.js) AND that are switched on under Settings → Launch
// (web/js/core/launch.js: simple pricing hides Pricing; simple stock hides
// Inventory and Procurement). Opening a route by hand without permission shows
// a friendly "no access" page; the database refuses the data anyway.
// =============================================================================

import { requireRole } from '../../core/auth.js';
import { renderShell, startRouter } from '../../core/shell.js';
import { $, html, mount } from '../../core/ui.js';
import { getDashboardStats, getCompanySettings } from '../../core/api.js';
import { can, visibleNav } from '../../core/permissions.js';
import { hiddenModules } from '../../core/launch.js';
import { renderDashboard } from './dashboard.js';
import { renderOrders } from './orders.js';
import { renderProducts } from './products.js';
import { renderCustomers } from './customers.js';
import { renderTeam } from './team.js';
import { renderInventory } from './inventory.js';
import { renderSettings } from './settings.js';
import { renderLaunch } from './launch.js';
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
import { renderPickList } from './fulfilment.js';
import { renderTrips } from './trips.js';
import { renderDriverCash } from './driver-cash.js';
import { renderDeliveryCharges } from './delivery-charges.js';
import { renderSlots } from './slots.js';
import { renderIssues } from './issues.js';
import { renderReceivables, renderPaymentReceipts } from './payments.js';
import { renderNotifications } from './notifications.js';
import { renderTickets } from './tickets.js';
import { renderHelpCentre } from './help-centre.js';
import { renderWebsite } from './website.js';
import { renderReports } from './reports.js';
import { renderCoupons } from './coupons.js';
import { renderQuotes } from './quotes.js';

/** Sub-pages keep their parent menu item highlighted. */
const PARENT_OF = { '#launch': '#settings', '#locations': '#settings', '#sectors': '#settings', '#roles': '#settings',
                    '#pricing-rules': '#pricing', '#benchmarks': '#pricing', '#price-lists': '#pricing',
                    '#purchase-orders': '#procurement', '#receipts': '#procurement', '#rate-cards': '#procurement',
                    '#trips': '#fulfilment', '#driver-cash': '#fulfilment', '#delivery-charges': '#fulfilment',
                    '#slots': '#settings', '#issues': '#orders', '#payments-receipts': '#payments',
                    '#notifications': '#settings', '#help-centre': '#settings', '#website': '#settings', '#tickets': '#orders', '#coupons': '#settings', '#quotes': '#orders' };

const me = await requireRole('admin');
if (me) {
  // Launch modes (migration 014) decide which modules the menu shows. If the
  // read fails the full menu shows; the database still enforces every rule.
  const settings = await getCompanySettings().catch(() => ({}));
  const hidden = hiddenModules(settings);
  const shell = renderShell({ me, subtitle: 'Admin', links: visibleNav(me, hidden) });

  // Show the number of customers waiting for approval on the Customers tab.
  if (can(me, 'customers', 'view')) {
    getDashboardStats().then((s) => shell.setBadge('#customers', s.pending_restaurants)).catch(() => {});
  }

  /** Wrap a screen so it only renders when `me` may view `module` and the module is switched on. */
  const guard = (module, render) => (container) => {
    if (!can(me, module, 'view')) {
      mount(container, html`<div class="empty"><strong>No access</strong>Your team role does not include ${module}. Ask a super admin.</div>`);
      return;
    }
    if (hidden.has(module)) {
      mount(container, html`<div class="empty"><strong>Switched off</strong>${module} is hidden by the current launch mode.
        ${can(me, 'settings', 'edit') ? html`Turn it on under <a href="#launch">Settings → Launch</a>.` : 'Ask an admin to change it under Settings → Launch.'}</div>`);
      return;
    }
    return render(container);
  };

  startRouter({
    container: $('#view'),
    fallback: can(me, 'dashboard', 'view') ? '#dashboard' : (visibleNav(me, hidden)[0]?.href ?? '#dashboard'),
    onRoute: (key) => shell.setActive(PARENT_OF[key] ?? key),
    routes: {
      '#dashboard': guard('dashboard', (c) => renderDashboard(c, me, settings)),
      '#orders':    guard('orders', (c) => renderOrders(c, me)),
      '#products':  guard('products', (c) => renderProducts(c, me, settings)),
      '#inventory': guard('inventory', (c) => renderInventory(c, me)),
      '#customers': guard('customers', (c) => renderCustomers(c, me, (count) => shell.setBadge('#customers', count))),
      '#team':      guard('team', (c) => renderTeam(c, me)),
      '#settings':  guard('settings', (c) => renderSettings(c, me)),
      '#launch':    guard('settings', (c) => renderLaunch(c, me)),
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
      '#fulfilment': guard('fulfilment', (c) => renderPickList(c, me)),
      '#trips': guard('fulfilment', (c) => renderTrips(c, me)),
      '#driver-cash': guard('fulfilment', (c) => renderDriverCash(c, me)),
      '#delivery-charges': guard('fulfilment', (c) => renderDeliveryCharges(c, me)),
      '#slots': guard('settings', (c) => renderSlots(c, me)),
      '#issues': guard('orders', (c) => renderIssues(c, me)),
      '#payments': guard('payments', (c) => renderReceivables(c, me)),
      '#payments-receipts': guard('payments', (c) => renderPaymentReceipts(c, me)),
      '#notifications': guard('settings', (c) => renderNotifications(c, me)),
      '#help-centre': guard('settings', (c) => renderHelpCentre(c, me)),
      '#tickets': guard('orders', (c) => renderTickets(c, me)),
      '#website': guard('settings', (c) => renderWebsite(c, me)),
      '#reports': guard('reports', (c) => renderReports(c, me)),
      '#coupons': guard('settings', (c) => renderCoupons(c, me)),
      '#quotes': guard('orders', (c) => renderQuotes(c, me)),
    },
  });
}
