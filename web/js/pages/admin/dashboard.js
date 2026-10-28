// =============================================================================
// dashboard.js — headline numbers for the day, the launch-mode banner
// (Settings → Launch, migration 014) and the receivables tiles (migration 015).
// =============================================================================

import { html, mount, formatINR, STATUS_LABELS, statusBadge } from '../../core/ui.js';
import { getDashboardStats, listProducts, listSectors } from '../../core/api.js';
import { stockLevel } from './inventory.js';
import { isSimpleStock, launchSummary } from '../../core/launch.js';
import { can } from '../../core/permissions.js';

const OPEN_STATUSES = ['placed', 'confirmed', 'packed', 'out_for_delivery'];

export async function renderDashboard(container, me, settings = {}) {
  const [s, products, sectors] = await Promise.all([getDashboardStats(), listProducts(), listSectors().catch(() => [])]);
  const open = s.open_orders_by_status ?? {};
  const simpleStock = isSimpleStock(settings);
  const lowStock = simpleStock ? products.filter((p) => p.is_active && !p.in_stock) : products.filter((p) => p.is_active && stockLevel(p) !== 'ok');
  const launch = launchSummary(settings, sectors);

  mount(container, html`
    <div class="page-head"><div><h1>Dashboard</h1><p>Today's activity (India time)</p></div></div>
    ${launch.length ? html`<div class="banner info" id="launch-banner"><div><strong>Launch mode.</strong> ${launch.join(' · ')}.
      ${can(me, 'settings', 'view') ? html`<a href="#launch">Change</a>` : ''}</div></div>` : ''}
    ${s.pending_restaurants > 0 ? html`<div class="banner warn">
      ${s.pending_restaurants} customer${s.pending_restaurants === 1 ? '' : 's'} waiting for approval. <a href="#customers">Review</a></div>` : ''}
    <div class="stat-grid">
      <div class="card stat"><div class="stat-label">Orders today</div><div class="stat-value">${s.orders_today}</div></div>
      <div class="card stat"><div class="stat-label">Revenue today</div><div class="stat-value">${formatINR(s.revenue_today)}</div><div class="stat-note">excludes cancelled</div></div>
      <div class="card stat"><div class="stat-label">Revenue, 7 days</div><div class="stat-value">${formatINR(s.revenue_7d)}</div></div>
      <div class="card stat"><div class="stat-label">Awaiting approval</div><div class="stat-value">${s.pending_restaurants}</div></div>
      ${simpleStock
        ? html`<div class="card stat"><div class="stat-label">Out of stock</div><div class="stat-value">${lowStock.length}</div><div class="stat-note"><a href="#products">Open products</a></div></div>`
        : html`<div class="card stat"><div class="stat-label">Low / empty stock</div><div class="stat-value">${lowStock.length}</div><div class="stat-note"><a href="#inventory">Open inventory</a></div></div>`}
      ${s.receivables_open != null ? html`<div class="card stat"><div class="stat-label">Receivables</div><div class="stat-value">${formatINR(s.receivables_open)}</div>
        <div class="stat-note" style="${Number(s.receivables_overdue) > 0 ? 'color:var(--danger)' : ''}">${formatINR(s.receivables_overdue)} overdue${can(me, 'payments', 'view') ? html` · <a href="#payments">Payments</a>` : ''}</div></div>` : ''}
    </div>

    <div class="form-grid" style="margin-top:var(--space-5);align-items:start">
      <section class="card">
        <div class="card-head"><h2>Open orders</h2><a href="#orders" class="small">View all</a></div>
        <div class="card-pad stack-sm">
          ${OPEN_STATUSES.map((st) => html`<div class="spread">${statusBadge(st)}<span class="num"><strong>${open[st] ?? 0}</strong></span></div>`)}
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Top products, 30 days</h2></div>
        ${s.top_products_30d.length === 0
          ? html`<div class="empty">No sales yet.</div>`
          : html`<div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Revenue</th></tr></thead>
            <tbody>${s.top_products_30d.map((p) => html`<tr><td>${p.name}</td><td class="right num">${Number(p.quantity)}</td><td class="right money">${formatINR(p.revenue)}</td></tr>`)}</tbody></table></div>`}
      </section>
    </div>`);
}
