// =============================================================================
// issues.js — Orders → Issues: problems customers report on their orders, and
// the credit notes raised when support resolves them. Resolving needs
// orders:edit; a credit amount raises a credit note (applied to the account
// balance in batch 7, Payments & credit).
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, formatDateTime, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listOrderIssues, resolveIssue, listCreditNotes, getOrder } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { ISSUE_KINDS, ISSUE_STATUSES } from '../../core/config.js';

export async function renderIssues(container, me) {
  const canResolve = can(me, 'orders', 'edit');
  let tab = 'open';
  let issues = [];
  let credits = [];

  async function load() {
    if (tab === 'credit') credits = await listCreditNotes();
    else issues = await listOrderIssues(tab === 'all' ? {} : { status: 'open' });
    draw();
  }

  function tabs() {
    const t = [['open', 'Open issues'], ['all', 'All issues'], ['credit', 'Credit notes']];
    return html`<div class="tabs" role="tablist">${t.map(([k, l]) => html`<a role="tab" href="#issues" aria-selected="${String(k === tab)}" data-tab="${k}">${l}</a>`)}</div>`;
  }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Issues & credits</h1><p>${tab === 'credit' ? `${credits.length} credit notes` : `${issues.length} ${tab === 'open' ? 'open' : ''} issue${issues.length === 1 ? '' : 's'}`}</p></div></div>
      ${tabs()}
      ${tab === 'credit'
        ? html`<div class="card"><div class="table-wrap"><table class="table">
            <thead><tr><th>Credit note</th><th>Customer</th><th>Order</th><th class="right">Amount</th><th>When</th><th>Reason</th></tr></thead>
            <tbody>${credits.length === 0 ? html`<tr><td colspan="6"><div class="empty">No credit notes yet.</div></td></tr>` : credits.map((c) => html`
              <tr><td><strong>${c.credit_note_number}</strong></td><td>${c.restaurants?.name ?? '—'}</td><td>${c.orders?.order_number ?? '—'}</td>
                <td class="right num money">${formatINR(c.amount)}</td><td class="muted small">${formatDate(c.created_at)}</td><td class="small">${c.reason ?? ''}</td></tr>`)}</tbody></table></div></div>`
        : html`<div class="card"><div class="table-wrap"><table class="table">
            <thead><tr><th>Order</th><th>Customer</th><th>Type</th><th>Reported</th><th>Status</th><th></th></tr></thead>
            <tbody>${issues.length === 0 ? html`<tr><td colspan="6"><div class="empty">No issues.</div></td></tr>` : issues.map((i) => html`
              <tr><td><strong>${i.orders?.order_number ?? '—'}</strong></td><td>${i.restaurants?.name ?? '—'}</td>
                <td>${ISSUE_KINDS[i.kind]?.label ?? i.kind}</td><td class="muted small">${formatDateTime(i.created_at)}</td>
                <td><span class="badge ${ISSUE_STATUSES[i.status]?.badge ?? ''}">${ISSUE_STATUSES[i.status]?.label ?? i.status}</span></td>
                <td class="right"><button class="btn small" data-open="${i.id}">View</button></td></tr>`)}</tbody></table></div></div>`}`);
  }

  on(container, 'click', '[data-tab]', (_e, el) => { tab = el.dataset.tab; load().catch(reportError); });
  on(container, 'click', '[data-open]', (_e, el) => detail(issues.find((i) => i.id === el.dataset.open)));

  async function detail(issue) {
    const order = await getOrder(issue.order_id).catch(() => null);
    const { el, close } = openModal(html`
      <div class="stack">
        <div><strong>${issue.orders?.order_number ?? ''}</strong> · ${ISSUE_KINDS[issue.kind]?.label ?? issue.kind}
          <span class="badge ${ISSUE_STATUSES[issue.status]?.badge ?? ''}">${ISSUE_STATUSES[issue.status]?.label ?? issue.status}</span></div>
        <p class="muted">${issue.note ?? ''}</p>
        ${order ? html`<div class="muted small">Order total ${formatINR(order.total_amount)} · ${formatDate(order.delivery_date)}</div>` : ''}
        ${issue.status !== 'open' ? html`<p class="small"><strong>Resolution:</strong> ${issue.resolution ?? '—'}</p>` : ''}
        ${issue.status === 'open' && canResolve ? html`
          <form id="resolve" class="stack" novalidate>
            <label class="field"><span class="label">Resolution note</span><input class="input" name="resolution" maxlength="300" placeholder="What was agreed" required></label>
            <label class="field"><span class="label">Credit note amount (₹, 0 = no credit)</span><input class="input" name="credit" type="number" min="0" step="0.01" value="0"></label>
            <p class="form-error" id="resolve-error" role="alert"></p>
            <div class="row" style="justify-content:flex-end"><button type="button" class="btn danger" id="reject">Decline</button><button class="btn primary" type="submit">Resolve</button></div>
          </form>` : html`<div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Close</button></div>`}
      </div>`, { title: 'Issue' });
    const run = async (button, opts) => {
      try { const r = await withBusy(button, () => resolveIssue(issue.id, opts)); toast(r.credit_note ? `Resolved · ${r.credit_note} for ${formatINR(r.amount)}` : 'Resolved', 'success'); close(); await load(); }
      catch (error) { $('#resolve-error', el).textContent = error.message; }
    };
    const formEl = $('#resolve', el);
    if (formEl) {
      formEl.onsubmit = (event) => { event.preventDefault(); if (!event.target.elements.resolution.value.trim()) { $('#resolve-error', el).textContent = 'Add a resolution note.'; return; } run($('button[type="submit"]', event.target), { resolution: event.target.elements.resolution.value, creditAmount: event.target.elements.credit.value }); };
      $('#reject', el).onclick = () => run($('#reject', el), { resolution: formEl.elements.resolution.value || 'Declined', reject: true });
    }
  }

  await load();
}
