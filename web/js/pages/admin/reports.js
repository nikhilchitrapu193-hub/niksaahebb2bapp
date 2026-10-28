// =============================================================================
// reports.js — Reports (migration 019): sales by day / city / sector / customer /
// product / category for a date range, and the receivables trend by week.
// Needs reports:view; the CSV button needs reports:export. A city manager sees
// only their city (in_my_scope inside sales_report); the city filter narrows
// further for people who see several.
// =============================================================================

import { html, mount, on, $, formatINR, reportError } from '../../core/ui.js';
import { getSalesReport, getReceivablesTrend, listCities } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { REPORT_GROUPINGS } from '../../core/config.js';
import { reportTotals, reportColumns, barHeights, lastNDays, shortDate } from '../../core/reports.js';
import { downloadCsv } from '../../core/csv.js';

export async function renderReports(container, me) {
  const cities = await listCities().catch(() => []);
  const scopedCity = me.profile?.city_id ?? null;
  const state = { tab: 'sales', groupBy: 'day', cityId: scopedCity, weeks: 12, ...lastNDays(30), rows: [], trend: [] };

  async function load() {
    if (state.tab === 'sales') state.rows = await getSalesReport({ from: state.from, to: state.to, groupBy: state.groupBy, cityId: state.cityId });
    else state.trend = await getReceivablesTrend(state.weeks, state.cityId);
    draw();
  }

  function cityFilter() {
    if (scopedCity || cities.length < 2) return '';
    return html`<select class="select" data-f="cityId" aria-label="City"><option value="">All cities</option>
      ${cities.map((c) => html`<option value="${c.id}" ${c.id === state.cityId ? 'selected' : ''}>${c.name}</option>`)}</select>`;
  }

  function sales() {
    const cols = reportColumns(state.groupBy);
    const totals = reportTotals(state.rows);
    return html`
      <div class="toolbar">
        <label class="field"><span class="label">From</span><input class="input" type="date" data-f="from" value="${state.from}"></label>
        <label class="field"><span class="label">To</span><input class="input" type="date" data-f="to" value="${state.to}"></label>
        <label class="field"><span class="label">Group</span><select class="select" data-f="groupBy">${Object.entries(REPORT_GROUPINGS).map(([k, v]) => html`<option value="${k}" ${k === state.groupBy ? 'selected' : ''}>${v.label}</option>`)}</select></label>
        ${cityFilter()}
        <span class="muted small">${state.rows.length} rows · ${totals.orders} orders · ${formatINR(totals.total)}</span>
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr>${cols.map((c) => html`<th class="${c.numeric ? 'right' : ''}">${c.label}</th>`)}</tr></thead>
        <tbody>${state.rows.length === 0 ? html`<tr><td colspan="${cols.length}"><div class="empty">No orders in this range.</div></td></tr>`
          : state.rows.map((r) => html`<tr>${cols.map((c) => html`<td class="${c.numeric ? 'right num' : ''}${c.money ? ' money' : ''}">${c.money ? formatINR(r[c.key]) : c.key === 'label' ? r.label : (r[c.key] ?? '—')}</td>`)}</tr>`)}</tbody>
        ${state.rows.length ? html`<tfoot><tr>${cols.map((c, i) => html`<td class="${c.numeric ? 'right num' : ''}"><strong>${i === 0 ? 'Total' : c.money ? formatINR(totals[c.key]) : (totals[c.key] ?? '')}</strong></td>`)}</tr></tfoot>` : ''}
      </table></div></div>`;
  }

  function trend() {
    const open = barHeights(state.trend.map((w) => w.open));
    const last = state.trend.at(-1);
    return html`
      <div class="toolbar">
        <label class="field"><span class="label">Weeks</span><select class="select" data-f="weeks">${[8, 12, 26, 52].map((n) => html`<option value="${n}" ${n === state.weeks ? 'selected' : ''}>${n}</option>`)}</select></label>
        ${cityFilter()}
        ${last ? html`<span class="muted small">Open now ${formatINR(last.open)} · overdue ${formatINR(last.overdue)}</span>` : ''}
      </div>
      <div class="card card-pad">
        <div class="bars" role="img" aria-label="Open receivables per week">${state.trend.map((w, i) => html`<div class="bar-col" title="${shortDate(w.week_end)}: open ${formatINR(w.open)}, overdue ${formatINR(w.overdue)}">
          <div class="bar" style="height:${open[i]}%"><div class="bar-overdue" style="height:${w.open > 0 ? Math.round((w.overdue / w.open) * 100) : 0}%"></div></div>
          <span class="bar-label">${shortDate(w.week_end)}</span></div>`)}</div>
        <p class="muted small" style="margin-top:var(--space-3)">Bars: open receivables at the end of each week; the darker part is overdue.</p>
      </div>
      <div class="card" style="margin-top:var(--space-4)"><div class="table-wrap"><table class="table">
        <thead><tr><th>Week ending</th><th class="right">Invoiced</th><th class="right">Collected</th><th class="right">Open</th><th class="right">Overdue</th></tr></thead>
        <tbody>${state.trend.map((w) => html`<tr><td>${shortDate(w.week_end)}</td><td class="right money">${formatINR(w.invoiced)}</td><td class="right money">${formatINR(w.collected)}</td><td class="right money">${formatINR(w.open)}</td><td class="right money ${Number(w.overdue) > 0 ? 'danger-text' : ''}">${formatINR(w.overdue)}</td></tr>`)}</tbody>
      </table></div></div>`;
  }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Reports</h1><p>${state.tab === 'sales' ? 'Sales for a date range, grouped the way you need.' : 'What customers owed at the end of each week.'}</p></div>
        ${can(me, 'reports', 'export') ? html`<button class="btn" id="export">Export CSV</button>` : ''}</div>
      <div class="tabs" role="tablist"><a role="tab" href="#reports" aria-selected="${String(state.tab === 'sales')}" data-tab="sales">Sales</a><a role="tab" href="#reports" aria-selected="${String(state.tab === 'trend')}" data-tab="trend">Receivables trend</a></div>
      ${state.tab === 'sales' ? sales() : trend()}`);
  }

  on(container, 'click', '[data-tab]', (_e, el) => { state.tab = el.dataset.tab; load().catch(reportError); });
  on(container, 'change', '[data-f]', (_e, el) => {
    state[el.dataset.f] = el.dataset.f === 'weeks' ? Number(el.value) : (el.value || null);
    if (el.dataset.f === 'from' || el.dataset.f === 'to') { if (!state.from || !state.to) return; }
    load().catch(reportError);
  });
  on(container, 'click', '#export', () => {
    if (state.tab === 'sales') {
      const cols = reportColumns(state.groupBy).map((c) => ({ key: c.key, label: c.label }));
      downloadCsv(`sales-${state.groupBy}-${state.from}-to-${state.to}.csv`, state.rows, cols);
    } else {
      downloadCsv(`receivables-trend-${state.weeks}w.csv`, state.trend, [{ key: 'week_end', label: 'Week ending' }, { key: 'invoiced', label: 'Invoiced' }, { key: 'collected', label: 'Collected' }, { key: 'open', label: 'Open' }, { key: 'overdue', label: 'Overdue' }]);
    }
  });

  await load();
}
