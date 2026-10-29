// =============================================================================
// ordering-plus.js — customer app → Standing orders · Quotes · Spend (migration
// 021). One route (#plus) with three tabs, plus the "save as standing order"
// dialog the cart opens and the CSV upload dialog the catalogue opens.
//   Standing orders: saved baskets that place themselves for chosen weekdays.
//   Quotes: priced baskets our team sent; accept into an order or decline.
//   Spend: what the account bought, by month / product / outlet, with CSV.
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, formatDateTime, formatQty, openModal, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listStandingOrders, saveStandingOrder, setStandingOrderActive, listQuotes, acceptQuote, declineQuote, getMySpendReport } from '../../core/api.js';
import { DELIVERY_SLOTS, PAYMENT_METHODS, QUOTE_STATUSES, WEEKDAYS } from '../../core/config.js';
import { csvToCartLines, bulkOrderTemplate } from '../../core/bulk-order.js';
import { parseCsv, downloadCsv } from '../../core/csv.js';
import { lastNDays, reportTotals } from '../../core/reports.js';
import { cartEntries, setQty } from './cart.js';

const dayLabels = (days) => WEEKDAYS.filter((d) => days.includes(d.value)).map((d) => d.label).join(', ');

export async function renderOrderingPlus(container, state, tab = 'standing') {
  const terms = state.terms ?? {};
  const outlets = (terms.outlets ?? []).filter((o) => o.is_active);
  let standing = [];
  let quotes = [];
  let spend = { groupBy: 'month', ...lastNDays(90), rows: [] };
  let current = tab;

  async function load() {
    if (current === 'standing') standing = await listStandingOrders();
    else if (current === 'quotes') quotes = await listQuotes();
    else spend.rows = await getMySpendReport({ from: spend.from, to: spend.to, groupBy: spend.groupBy });
    draw();
  }

  function tabs() {
    const t = [['standing', 'Standing orders'], ['quotes', `Quotes${quotes.filter((q) => q.status === 'sent').length ? ` (${quotes.filter((q) => q.status === 'sent').length})` : ''}`], ['spend', 'Spend']];
    return html`<div class="tabs" role="tablist">${t.map(([k, l]) => html`<a role="tab" href="#plus" aria-selected="${String(k === current)}" data-tab="${k}">${l}</a>`)}</div>`;
  }

  function standingTab() {
    return html`
      <div class="row" style="justify-content:flex-end;margin-bottom:var(--space-3)"><button class="btn primary" id="new-standing">New standing order</button></div>
      ${standing.length === 0 ? html`<div class="empty"><strong>No standing orders yet</strong>Save a basket once and it places itself every week — from the cart ("Save as standing order") or here.</div>`
        : standing.map((s) => html`<article class="card order-card" data-standing="${s.id}">
          <div class="spread"><div><strong>${s.name}</strong> <span class="muted small">· ${dayLabels(s.days_of_week)} · ${DELIVERY_SLOTS[s.delivery_slot]?.label ?? s.delivery_slot}${outlets.length > 1 && s.outlets?.name ? ` · ${s.outlets.name}` : ''}</span></div>
            ${s.is_active ? html`<span class="badge delivered">active</span>` : html`<span class="badge inactive">paused</span>`}</div>
          <div class="muted small" style="margin:var(--space-2) 0">${s.items.length} line${s.items.length === 1 ? '' : 's'} · ${PAYMENT_METHODS[s.payment_method]?.label ?? ''}${s.po_reference ? ` · PO ${s.po_reference}` : ''}
            ${s.last_run_at ? html` · last placed ${formatDateTime(s.last_run_at)} for ${formatDate(s.last_run_date)}` : ' · not placed yet'}</div>
          ${s.last_error ? html`<div class="banner warn">Last attempt failed: ${s.last_error}</div>` : ''}
          <div class="row" style="justify-content:flex-end;gap:var(--space-2)">
            <button class="btn small" data-edit-standing="${s.id}">Edit</button>
            <button class="btn small ${s.is_active ? 'danger' : 'primary'}" data-toggle-standing="${s.id}" data-active="${s.is_active}">${s.is_active ? 'Pause' : 'Resume'}</button></div>
        </article>`)}`;
  }

  function quotesTab() {
    return quotes.length === 0 ? html`<div class="empty"><strong>No quotes</strong>When our team prices a basket for you it appears here.</div>`
      : quotes.map((q) => html`<article class="card order-card" data-quote="${q.id}">
          <div class="spread"><div><strong>${q.quote_number}</strong> <span class="muted small">· ${formatDate(q.created_at)} · valid until ${formatDate(q.valid_until)}</span></div>
            <span class="badge ${QUOTE_STATUSES[q.status]?.badge ?? ''}">${QUOTE_STATUSES[q.status]?.label ?? q.status}</span></div>
          <ul class="small" style="margin:var(--space-2) 0;padding-left:1.1rem">${q.items.map((i) => html`<li>${i.product_name} — ${formatQty(i.quantity)} ${i.unit} × ${formatINR(i.unit_price)} = ${formatINR(i.unit_price * i.quantity)}</li>`)}</ul>
          <div class="spread small"><span class="muted">${q.notes ?? ''}</span><span><span class="muted">Subtotal ${formatINR(q.subtotal)} · GST ${formatINR(q.tax_amount)} · </span><strong class="money">${formatINR(q.total_amount)}</strong></span></div>
          ${q.status === 'sent' ? html`<div class="row" style="justify-content:flex-end;gap:var(--space-2);margin-top:var(--space-3)">
            <button class="btn danger" data-decline-quote="${q.id}">Decline</button>
            ${terms.can_approve ? html`<button class="btn primary" data-accept-quote="${q.id}">Accept &amp; order</button>` : html`<span class="muted small">The account owner or an approver can accept it.</span>`}</div>` : ''}
          ${q.status === 'accepted' ? html`<p class="muted small" style="margin-top:var(--space-2)">Ordered — see <a href="#orders">My orders</a>.</p>` : ''}
        </article>`);
  }

  function spendTab() {
    const totals = reportTotals(spend.rows);
    const byProduct = spend.groupBy === 'product';
    return html`
      <div class="toolbar">
        <label class="field"><span class="label">From</span><input class="input" type="date" data-s="from" value="${spend.from}"></label>
        <label class="field"><span class="label">To</span><input class="input" type="date" data-s="to" value="${spend.to}"></label>
        <label class="field"><span class="label">Group</span><select class="select" data-s="groupBy">
          ${[['month', 'By month'], ['product', 'By product'], ['outlet', 'By outlet']].map(([k, l]) => html`<option value="${k}" ${k === spend.groupBy ? 'selected' : ''}>${l}</option>`)}</select></label>
        <span class="muted small">${totals.orders} orders · ${formatINR(totals.total)}</span>
        <button class="btn" id="spend-csv">Export CSV</button></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>${byProduct ? 'Product' : spend.groupBy === 'month' ? 'Month' : 'Outlet'}</th><th class="right">Orders</th>${byProduct ? html`<th class="right">Quantity</th>` : ''}<th class="right">Spend</th></tr></thead>
        <tbody>${spend.rows.length === 0 ? html`<tr><td colspan="4"><div class="empty">No orders in this range.</div></td></tr>` : spend.rows.map((r) => html`<tr><td>${r.label}</td><td class="right num">${r.orders}</td>${byProduct ? html`<td class="right num">${Number(r.quantity)}</td>` : ''}<td class="right money">${formatINR(r.total)}</td></tr>`)}</tbody>
      </table></div></div>`;
  }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Standing orders, quotes &amp; spend</h1><p>Baskets that place themselves, prices our team quoted you, and what you have bought.</p></div></div>
      ${tabs()}
      ${current === 'standing' ? standingTab() : current === 'quotes' ? quotesTab() : spendTab()}`);
  }

  on(container, 'click', '[data-tab]', (_e, el) => { current = el.dataset.tab; load().catch(reportError); });
  on(container, 'click', '#new-standing', () => standingOrderDialog(state, null, () => load().catch(reportError)));
  on(container, 'click', '[data-edit-standing]', (_e, b) => standingOrderDialog(state, standing.find((s) => s.id === b.dataset.editStanding), () => load().catch(reportError)));
  on(container, 'click', '[data-toggle-standing]', async (_e, b) => {
    try { await setStandingOrderActive(b.dataset.toggleStanding, b.dataset.active !== 'true'); toast(b.dataset.active === 'true' ? 'Paused' : 'Resumed', 'success'); await load(); } catch (error) { reportError(error); }
  });
  on(container, 'click', '[data-decline-quote]', async (_e, b) => {
    const reason = window.prompt('Reason (optional)'); if (reason === null) return;
    try { await declineQuote(b.dataset.declineQuote, reason); toast('Quote declined', 'info'); await load(); } catch (error) { reportError(error); }
  });
  on(container, 'click', '[data-accept-quote]', (_e, b) => acceptQuoteDialog(quotes.find((q) => q.id === b.dataset.acceptQuote), state, () => load().catch(reportError)));
  on(container, 'change', '[data-s]', (_e, el) => { spend[el.dataset.s] = el.value; if (spend.from && spend.to) load().catch(reportError); });
  on(container, 'click', '#spend-csv', () => downloadCsv(`spend-${spend.groupBy}-${spend.from}-to-${spend.to}.csv`, spend.rows,
    [{ key: 'label', label: 'Group' }, { key: 'orders', label: 'Orders' }, { key: 'quantity', label: 'Quantity' }, { key: 'total', label: 'Spend (₹)' }]));

  await load();
}

/** Save the cart (or an existing template) as a standing order. Exported: the cart drawer opens it too. */
export function standingOrderDialog(state, existing, onSaved) {
  const products = state.byId ?? {};
  const outlets = (state.terms?.outlets ?? []).filter((o) => o.is_active);
  const items = existing ? existing.items : cartEntries().map(({ productId, quantity }) => ({ product_id: productId, quantity }));
  if (!items.length) { toast('Add products to the cart first.', 'error'); return; }
  const days = new Set(existing?.days_of_week ?? [1, 2, 3, 4, 5, 6]);
  const { el, close } = openModal(html`<form id="standing-form" class="stack" novalidate>
    <label class="field"><span class="label">Name</span><input class="input" name="name" maxlength="120" value="${existing?.name ?? ''}" placeholder="Daily veg, Weekend dairy…" required></label>
    <div class="field"><span class="label">Deliver on</span><div class="row-wrap" id="days">${WEEKDAYS.map((d) => html`<label class="check"><input type="checkbox" name="day" value="${d.value}" ${days.has(d.value) ? 'checked' : ''}> ${d.label}</label>`)}</div>
      <span class="hint">The order is placed the evening before, for the next morning / slot.</span></div>
    <div class="form-grid">
      <label class="field"><span class="label">Slot</span><select class="select" name="slot">${Object.entries(DELIVERY_SLOTS).filter(([k]) => k !== 'express').map(([k, v]) => html`<option value="${k}" ${k === (existing?.delivery_slot ?? 'morning') ? 'selected' : ''}>${v.label}</option>`)}</select></label>
      <label class="field"><span class="label">Payment</span><select class="select" name="payment">${Object.entries(PAYMENT_METHODS).map(([k, v]) => html`<option value="${k}" ${k === (existing?.payment_method ?? 'cod') ? 'selected' : ''}>${v.label}</option>`)}</select></label>
      ${outlets.length > 1 ? html`<label class="field"><span class="label">Outlet</span><select class="select" name="outlet">${outlets.map((o) => html`<option value="${o.id}" ${o.id === (existing?.outlet_id ?? outlets.find((x) => x.is_primary)?.id) ? 'selected' : ''}>${o.name}</option>`)}</select></label>` : ''}
      ${state.terms?.needs_po_reference ? html`<label class="field"><span class="label">PO / indent number</span><input class="input" name="po" maxlength="60" value="${existing?.po_reference ?? ''}" required></label>` : ''}
    </div>
    <div class="card card-pad"><strong class="small">Basket</strong><ul class="small" style="margin:var(--space-2) 0 0;padding-left:1.1rem">${items.map((i) => html`<li>${products[i.product_id]?.name ?? i.product_id} — ${formatQty(i.quantity)} ${products[i.product_id]?.unit ?? ''}</li>`)}</ul></div>
    <p class="form-error" id="standing-error" role="alert"></p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${existing ? 'Save' : 'Create standing order'}</button></div>
  </form>`, { title: existing ? `Edit ${existing.name}` : 'Save as standing order' });
  const form = $('#standing-form', el);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const chosen = [...form.querySelectorAll('[name="day"]:checked')].map((c) => Number(c.value));
    if (!form.elements.name.value.trim()) { $('#standing-error', el).textContent = 'Give it a name.'; return; }
    if (!chosen.length) { $('#standing-error', el).textContent = 'Choose at least one weekday.'; return; }
    try {
      await withBusy($('button[type="submit"]', form), () => saveStandingOrder({ id: existing?.id, name: form.elements.name.value, items, days: chosen, slot: form.elements.slot.value,
        paymentMethod: form.elements.payment.value, outletId: form.elements.outlet?.value, poReference: form.elements.po?.value, isActive: existing?.is_active ?? true }));
      toast(existing ? 'Standing order saved' : 'Standing order created — it places itself the evening before each delivery day', 'success'); close(); onSaved?.();
    } catch (error) { $('#standing-error', el).textContent = error.message; }
  };
}

function acceptQuoteDialog(quote, state, onDone) {
  const needsPo = Boolean(state.terms?.needs_po_reference);
  const { el, close } = openModal(html`<form id="accept-form" class="stack" novalidate>
    <p>Order <strong>${quote.quote_number}</strong> at the quoted prices — <strong>${formatINR(quote.total_amount)}</strong> before any delivery fee.</p>
    <div class="form-grid">
      <label class="field"><span class="label">Slot</span><select class="select" name="slot">${Object.entries(DELIVERY_SLOTS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
      <label class="field"><span class="label">Date</span><input class="input" type="date" name="date"><span class="hint">Blank = tomorrow (today for express)</span></label>
      <label class="field"><span class="label">Payment</span><select class="select" name="payment">${Object.entries(PAYMENT_METHODS).map(([k, v]) => html`<option value="${k}" ${k === 'credit' && state.terms?.credit_blocked_reason ? 'disabled' : ''}>${v.label}</option>`)}</select></label>
      ${needsPo ? html`<label class="field"><span class="label">PO / indent number</span><input class="input" name="po" maxlength="60" required></label>` : ''}
    </div>
    <p class="form-error" id="accept-error" role="alert"></p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Place order</button></div>
  </form>`, { title: `Accept ${quote.quote_number}` });
  $('#accept-form', el).onsubmit = async (event) => {
    event.preventDefault();
    const f = event.target;
    if (needsPo && !f.elements.po.value.trim()) { $('#accept-error', el).textContent = 'Enter the PO / indent number.'; return; }
    try {
      const r = await withBusy($('button[type="submit"]', f), () => acceptQuote(quote.id, { deliveryDate: f.elements.date.value || null, slot: f.elements.slot.value, paymentMethod: f.elements.payment.value, poReference: f.elements.po?.value }));
      toast(`Order ${r.order_number} placed — ${formatINR(r.total_amount)}`, 'success'); close(); onDone?.();
    } catch (error) { $('#accept-error', el).textContent = error.message; }
  };
}

/** "Upload your order (CSV)": parse → preview → add to cart. Exported for the catalogue page. */
export function bulkUploadDialog(state) {
  const products = state.products ?? [];
  const { el, close } = openModal(html`<div class="stack">
    <p class="small muted">A CSV with columns <code>sku</code> (or <code>product</code>) and <code>quantity</code>. <a href="#" id="bulk-template">Download the template</a> with your first products.</p>
    <input class="input" type="file" id="bulk-file" accept=".csv,text/csv">
    <div id="bulk-preview"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="bulk-add" disabled>Add to cart</button></div>
  </div>`, { title: 'Upload your order' });
  let prepared = { lines: [], problems: [] };
  $('#bulk-template', el).onclick = (e) => {
    e.preventDefault();
    const blob = new Blob(['﻿' + bulkOrderTemplate(products)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'order-template.csv'; a.click(); URL.revokeObjectURL(a.href);
  };
  $('#bulk-file', el).onchange = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    prepared = csvToCartLines(parseCsv(await file.text()), products);
    mount($('#bulk-preview', el), html`
      ${prepared.problems.length ? html`<div class="banner warn"><strong>${prepared.problems.length} note${prepared.problems.length === 1 ? '' : 's'}</strong><ul class="small" style="margin:var(--space-1) 0 0;padding-left:1.1rem">${prepared.problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
      ${prepared.lines.length ? html`<ul class="small" style="padding-left:1.1rem">${prepared.lines.map((l) => html`<li>${l.name} — ${formatQty(l.quantity)}</li>`)}</ul>` : html`<p class="muted small">Nothing to add.</p>`}`);
    $('#bulk-add', el).disabled = prepared.lines.length === 0;
  };
  $('#bulk-add', el).onclick = () => {
    for (const l of prepared.lines) setQty(l.product_id, l.quantity);
    toast(`${prepared.lines.length} line${prepared.lines.length === 1 ? '' : 's'} added to the cart`, 'success');
    close();
  };
}
