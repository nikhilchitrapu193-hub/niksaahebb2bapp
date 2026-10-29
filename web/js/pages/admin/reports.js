// =============================================================================
// reports.js — Admin: Finance & operations reports
// Route: #reports
//
// Tabs: Sales (table with totals) · Trend (weekly receivables bar chart)
// All data comes from sales_report() and receivables_trend() RPCs.
// =============================================================================

import { html, mount, on, reportError, formatINR } from '../../core/ui.js';
import { salesReport, receivablesTrend, listCities } from '../../core/api.js';
import { can } from '../../core/permissions.js';

export async function renderReports(container, me) {
  if (!can(me, 'reports', 'view')) {
    mount(container, html`<div class="empty"><strong>No access</strong>Your role does not include reports.</div>`);
    return;
  }

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  // Load cities for the city filter
  const cities = await listCities().catch(() => []);

  mount(container, html`
    <div class="page-head">
      <div><h1>Reports</h1><p>Finance and operations overview.</p></div>
      <button class="btn small" id="export">Export CSV</button>
    </div>
    <div class="filters row gap-sm mb-md">
      <label>Group by
        <select class="select-sm" data-f="groupBy">
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
          <option value="product">Product</option>
          <option value="sector">Sector</option>
          <option value="city">City</option>
        </select>
      </label>
      <label>City
        <select class="select-sm" data-f="cityId">
          <option value="">All cities</option>
          ${cities.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
        </select>
      </label>
      <label>From <input type="date" id="rpt-from" value="${firstOfMonth}"></label>
      <label>To   <input type="date" id="rpt-to"   value="${today}"></label>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="sales">Sales</button>
      <button class="tab" data-tab="trend">Trend</button>
    </div>
    <div id="tab-sales"></div>
    <div id="tab-trend" hidden></div>
  `);

  // Mutable state for current report data (used by CSV export)
  let currentRows = [];
  let currentGroupBy = 'day';

  on(container, 'click', '.tab', (_, btn) => {
    container.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    container.querySelector('#tab-sales').hidden = (tab !== 'sales');
    container.querySelector('#tab-trend').hidden = (tab !== 'trend');
    if (tab === 'trend') loadTrend();
  });

  on(container, 'change', '[data-f="groupBy"]', () => loadSales());
  on(container, 'change', '[data-f="cityId"]', () => loadSales());
  on(container, 'change', '#rpt-from', () => loadSales());
  on(container, 'change', '#rpt-to', () => loadSales());

  on(container, 'click', '#export', () => {
    const groupBy = container.querySelector('[data-f="groupBy"]')?.value ?? 'day';
    const from = container.querySelector('#rpt-from')?.value ?? firstOfMonth;
    const to = container.querySelector('#rpt-to')?.value ?? today;
    const hasQty = groupBy === 'product';
    const header = hasQty
      ? ['Key', 'Label', 'Orders', 'Quantity', 'Subtotal', 'Tax', 'Delivery fee', 'Total', 'Cancelled']
      : ['Key', 'Label', 'Orders', 'Subtotal', 'Tax', 'Delivery fee', 'Total', 'Cancelled'];
    const rows = currentRows.map((r) => hasQty
      ? [r.key, r.label, r.orders, r.quantity ?? 0, r.subtotal, r.tax, r.delivery_fee, r.total, r.cancelled]
      : [r.key, r.label, r.orders, r.subtotal, r.tax, r.delivery_fee, r.total, r.cancelled]);
    const csv = [header, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-${groupBy}-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  async function loadSales() {
    const groupBy = container.querySelector('[data-f="groupBy"]')?.value ?? 'day';
    const cityId = container.querySelector('[data-f="cityId"]')?.value ?? '';
    const from = container.querySelector('#rpt-from')?.value ?? firstOfMonth;
    const to = container.querySelector('#rpt-to')?.value ?? today;
    currentGroupBy = groupBy;
    const el = container.querySelector('#tab-sales');
    // Do NOT mount a loading spinner here — it removes the existing table and causes
    // waitFor() polling on 'thead' to throw when thead is momentarily absent while
    // the RPC resolves. Render directly once data arrives; the previous table stays
    // visible during the brief re-fetch.
    try {
      const rows = await salesReport({ groupBy, cityId: cityId || null, from, to });
      currentRows = rows ?? [];
      renderSalesTable(el, currentRows, groupBy);
    } catch (err) { reportError(err); }
  }

  function renderSalesTable(el, rows, groupBy) {
    const hasQty = groupBy === 'product';
    if (!rows.length) { mount(el, html`<p class="muted">No data for this period.</p>`); return; }
    const totOrders = rows.reduce((s, r) => s + (r.orders ?? 0), 0);
    const totQty = rows.reduce((s, r) => s + (r.quantity ?? 0), 0);
    const totTotal = rows.reduce((s, r) => s + (r.total ?? 0), 0);
    const totCancelled = rows.reduce((s, r) => s + (r.cancelled ?? 0), 0);
    mount(el, html`
      <table class="data-table">
        <thead><tr>
          <th>Label</th>
          <th>Orders</th>
          ${hasQty ? html`<th>Quantity</th>` : ''}
          <th>Total</th>
          <th>Cancelled</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => html`<tr>
            <td>${r.label}</td>
            <td>${r.orders}</td>
            ${hasQty ? html`<td>${r.quantity ?? 0}</td>` : ''}
            <td>${formatINR(r.total)}</td>
            <td>${r.cancelled ?? 0}</td>
          </tr>`)}
        </tbody>
        <tfoot><tr>
          <td><strong>Total</strong></td>
          <td><strong>${totOrders}</strong></td>
          ${hasQty ? html`<td><strong>${totQty}</strong></td>` : ''}
          <td><strong>${formatINR(totTotal)}</strong></td>
          <td><strong>${totCancelled}</strong></td>
        </tr></tfoot>
      </table>
    `);
  }

  async function loadTrend() {
    const el = container.querySelector('#tab-trend');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const rows = await receivablesTrend();
      if (!rows?.length) { mount(el, html`<p class="muted">No trend data.</p>`); return; }
      const latest = rows[rows.length - 1];
      const maxInvoiced = Math.max(...rows.map((r) => r.invoiced ?? 0), 1);
      mount(el, html`
        <p>Open now ${formatINR(latest.open ?? 0)}</p>
        <div class="bars" style="display:flex;gap:var(--space-3);align-items:flex-end;height:120px">
          ${rows.map((r) => {
            const h = Math.max(4, Math.round(((r.invoiced ?? 0) / maxInvoiced) * 100));
            return html`<div class="bar-col" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
              <div style="height:${h}px;width:100%;background:var(--primary,#4f46e5);border-radius:3px 3px 0 0" title="${formatINR(r.invoiced)}"></div>
              <small class="muted">${(r.week_end ?? '').slice(5)}</small>
            </div>`;
          })}
        </div>
      `);
    } catch (err) { reportError(err); }
  }

  // Initial load
  await loadSales();
}
