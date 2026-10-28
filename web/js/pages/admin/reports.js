// =============================================================================
// reports.js — Admin: Finance & operations reports (P2-6 update)
// Route: #reports
//
// Tabs: Revenue · Category mix · Sector breakdown · Day-by-day
// All data comes from P2-6 Postgres functions (finance_summary, category_mix,
// revenue_by_sector, revenue_by_day).
// =============================================================================

import { html, mount, on, reportError, formatINR } from '../../core/ui.js';
import { getFinanceSummary, getCategoryMix, getSupabase } from '../../core/api.js';
import { can } from '../../core/permissions.js';

export async function renderReports(container, me) {
  if (!can(me, 'reports', 'view')) {
    mount(container, html`<div class="empty"><strong>No access</strong>Your role does not include reports.</div>`);
    return;
  }

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const today = now.toISOString().slice(0,10);

  mount(container, html`
    <div class="page-head"><div><h1>Reports</h1><p>Finance and operations overview.</p></div></div>
    <div class="filters row gap-sm mb-md">
      <label>From <input type="date" id="rpt-from" value="${firstOfMonth}"></label>
      <label>To   <input type="date" id="rpt-to"   value="${today}"></label>
      <button class="btn primary" id="rpt-go">Load</button>
    </div>
    <div class="tabs" id="rpt-tabs">
      <button class="tab active" data-tab="summary">Summary</button>
      <button class="tab" data-tab="category">Category mix</button>
      <button class="tab" data-tab="sector">By sector</button>
      <button class="tab" data-tab="daily">Day-by-day</button>
    </div>
    <div id="tab-summary"></div>
    <div id="tab-category" hidden></div>
    <div id="tab-sector"   hidden></div>
    <div id="tab-daily"    hidden></div>
  `);

  on(container, 'click', '.tab', (_, btn) => {
    container.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    ['summary','category','sector','daily'].forEach((t) => {
      container.querySelector(`#tab-${t}`).hidden = (t !== tab);
    });
  });

  on(container, 'click', '#rpt-go', () => loadAll());

  // Auto-load on mount
  loadAll();

  function getRange() {
    return {
      from: container.querySelector('#rpt-from')?.value ?? firstOfMonth,
      to:   container.querySelector('#rpt-to')?.value ?? today,
    };
  }

  async function loadAll() {
    const { from, to } = getRange();
    await Promise.all([
      loadSummary(from, to),
      loadCategoryMix(from, to),
      loadSector(from, to),
      loadDaily(from, to),
    ]);
  }

  async function loadSummary(from, to) {
    const el = container.querySelector('#tab-summary');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const s = await getFinanceSummary(from, to);
      mount(el, html`
        <div class="kpi-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:var(--space-4);margin:var(--space-5) 0">
          ${kpiCard('GMV', formatINR(s.gmv))}
          ${kpiCard('Orders', String(s.orders))}
          ${kpiCard('Avg order', formatINR(s.avg_order))}
          ${kpiCard('Amount paid', formatINR(s.paid_amount))}
          ${kpiCard('Outstanding', formatINR(s.outstanding), s.outstanding > 0 ? 'warn' : '')}
        </div>
      `);
    } catch (err) { reportError(err); }
  }

  async function loadCategoryMix(from, to) {
    const el = container.querySelector('#tab-category');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const rows = await getCategoryMix(from, to);
      if (!rows?.length) { mount(el, html`<p class="muted">No data for this period.</p>`); return; }
      mount(el, html`
        <table class="data-table">
          <thead><tr><th>Category</th><th>Revenue</th><th>Share</th><th>Bar</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr>
            <td>${r.category_name}</td>
            <td>${formatINR(r.revenue)}</td>
            <td>${r.pct}%</td>
            <td><div style="background:var(--primary);height:8px;border-radius:4px;width:${r.pct}%;min-width:2px"></div></td>
          </tr>`).join('')}
          </tbody>
        </table>
      `);
    } catch (err) { reportError(err); }
  }

  async function loadSector(from, to) {
    const el = container.querySelector('#tab-sector');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const sb = getSupabase();
      const { data, error } = await sb.rpc('revenue_by_sector', { p_from: from, p_to: to });
      if (error) throw error;
      if (!data?.length) { mount(el, html`<p class="muted">No data.</p>`); return; }
      mount(el, html`
        <table class="data-table">
          <thead><tr><th>Sector</th><th>Orders</th><th>Revenue</th></tr></thead>
          <tbody>${data.map((r) => html`<tr>
            <td>${r.sector_name}</td><td>${r.orders}</td><td>${formatINR(r.revenue)}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      `);
    } catch (err) { reportError(err); }
  }

  async function loadDaily(from, to) {
    const el = container.querySelector('#tab-daily');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const sb = getSupabase();
      const { data, error } = await sb.rpc('revenue_by_day', { p_from: from, p_to: to });
      if (error) throw error;
      if (!data?.length) { mount(el, html`<p class="muted">No orders in this period.</p>`); return; }
      const max = Math.max(...data.map((r) => r.revenue));
      mount(el, html`
        <table class="data-table">
          <thead><tr><th>Date</th><th>Orders</th><th>Revenue</th><th>Chart</th></tr></thead>
          <tbody>${data.map((r) => html`<tr>
            <td>${r.day}</td><td>${r.orders}</td><td>${formatINR(r.revenue)}</td>
            <td><div style="background:var(--primary);height:8px;border-radius:4px;width:${max > 0 ? Math.round(r.revenue/max*100) : 0}%;min-width:2px"></div></td>
          </tr>`).join('')}
          </tbody>
        </table>
      `);
    } catch (err) { reportError(err); }
  }
}

function kpiCard(label, value, cls = '') {
  return html`<div class="card card-pad ${cls}">
    <div class="muted small">${label}</div>
    <div class="money" style="font-size:var(--text-xl);margin-top:var(--space-1)">${value}</div>
  </div>`;
}
