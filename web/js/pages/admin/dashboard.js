// =============================================================================
// dashboard.js — headline numbers for the day.
// =============================================================================

import { html, mount, formatINR, STATUS_LABELS, statusBadge } from '../../core/ui.js';
import { getDashboardStats, listProducts } from '../../core/api.js';
import { stockLevel } from './inventory.js';

const OPEN_STATUSES = ['placed', 'confirmed', 'packed', 'out_for_delivery'];

export async function renderDashboard(container) {
  const [s, products] = await Promise.all([getDashboardStats(), listProducts()]);
  const open = s.open_orders_by_status ?? {};
  const lowStock = products.filter((p) => p.is_active && stockLevel(p) !== 'ok');

  mount(container, html`
    <div class="page-head"><div><h1>Dashboard</h1><p>Today's activity (India time)</p></div></div>
    ${s.pending_restaurants > 0 ? html`<div class="banner warn">
      ${s.pending_restaurants} restaurant${s.pending_restaurants === 1 ? '' : 's'} waiting for approval. <a href="#customers">Review</a></div>` : ''}
    <div class="stat-grid">
      <div class="card stat"><div class="stat-label">Orders today</div><div class="stat-value">${s.orders_today}</div></div>
      <div class="card stat"><div class="stat-label">Revenue today</div><div class="stat-value">${formatINR(s.revenue_today)}</div><div class="stat-note">excludes cancelled</div></div>
      <div class="card stat"><div class="stat-label">Revenue, 7 days</div><div class="stat-value">${formatINR(s.revenue_7d)}</div></div>
      <div class="card stat"><div class="stat-label">Awaiting approval</div><div class="stat-value">${s.pending_restaurants}</div></div>
      <div class="card stat"><div class="stat-label">Low / empty stock</div><div class="stat-value">${lowStock.length}</div><div class="stat-note"><a href="#inventory">Open inventory</a></div></div>
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
