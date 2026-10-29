// =============================================================================
// quotes.js — Orders → Quotes & standing orders (migration 021).
//   Quotes: staff price a basket for a customer (quoted unit prices, a validity
//   date, notes), send it; the customer accepts it into an order at those prices
//   or declines. Needs orders:edit to create / send; orders:view to see.
//   Standing orders: every customer template in scope, with its last run and
//   any error; staff can pause / resume one (orders:edit).
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, formatDateTime, formatQty, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listQuotes, saveQuote, setQuoteStatus, listRestaurants, listProducts, listOutlets, listStandingOrders, setStandingOrderActive } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { QUOTE_STATUSES, DELIVERY_SLOTS, PAYMENT_METHODS, WEEKDAYS } from '../../core/config.js';
import { isoDate } from '../../core/reports.js';

export async function renderQuotes(container, me) {
  const canEdit = can(me, 'orders', 'edit');
  let tab = 'quotes';
  let quotes = [];
  let standing = [];

  async function load() {
    if (tab === 'quotes') quotes = await listQuotes(); else standing = await listStandingOrders();
    draw();
  }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Quotes &amp; standing orders</h1><p>${tab === 'quotes' ? 'Priced baskets for customers; they accept at the quoted prices.' : 'Baskets that place themselves for customers, with the last run.'}</p></div>
        <div class="row"><a class="btn" href="#orders">Orders</a>${tab === 'quotes' && canEdit ? html`<button class="btn primary" id="new-quote">New quote</button>` : ''}</div></div>
      <div class="tabs" role="tablist"><a role="tab" href="#quotes" aria-selected="${String(tab === 'quotes')}" data-tab="quotes">Quotes</a><a role="tab" href="#quotes" aria-selected="${String(tab === 'standing')}" data-tab="standing">Standing orders</a></div>
      ${tab === 'quotes' ? html`<div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Quote</th><th>Customer</th><th>Lines</th><th class="right">Total</th><th>Valid until</th><th>Status</th><th></th></tr></thead>
        <tbody>${quotes.length === 0 ? html`<tr><td colspan="7"><div class="empty">No quotes yet.</div></td></tr>` : quotes.map((q) => html`<tr data-quote="${q.id}">
          <td><strong>${q.quote_number}</strong><div class="muted tiny">${formatDate(q.created_at)}</div></td>
          <td>${q.restaurants?.name ?? '—'}${q.outlets?.name ? html`<div class="muted tiny">${q.outlets.name}</div>` : ''}</td>
          <td class="small">${q.items.length}</td>
          <td class="right money">${formatINR(q.total_amount)}</td>
          <td class="small nowrap">${formatDate(q.valid_until)}</td>
          <td><span class="badge ${QUOTE_STATUSES[q.status]?.badge ?? ''}">${QUOTE_STATUSES[q.status]?.label ?? q.status}</span></td>
          <td class="right nowrap"><button class="btn small" data-open="${q.id}">${canEdit && (q.status === 'draft' || q.status === 'sent') ? 'Edit' : 'View'}</button>
            ${canEdit && q.status === 'draft' ? html`<button class="btn primary small" data-send="${q.id}">Send</button>` : ''}
            ${canEdit && q.status === 'sent' ? html`<button class="btn ghost small" data-withdraw="${q.id}">Withdraw</button>` : ''}</td></tr>`)}</tbody></table></div></div>`
      : html`<div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Customer</th><th>Template</th><th>Days · slot</th><th>Last run</th><th>Status</th><th></th></tr></thead>
        <tbody>${standing.length === 0 ? html`<tr><td colspan="6"><div class="empty">No standing orders in your scope.</div></td></tr>` : standing.map((s) => html`<tr data-standing="${s.id}">
          <td>${s.restaurants?.name ?? '—'}${s.outlets?.name ? html`<div class="muted tiny">${s.outlets.name}</div>` : ''}</td>
          <td><strong>${s.name}</strong><div class="muted tiny">${s.items.length} lines · ${PAYMENT_METHODS[s.payment_method]?.label ?? ''}</div></td>
          <td class="small">${WEEKDAYS.filter((d) => s.days_of_week.includes(d.value)).map((d) => d.label).join(', ')} · ${DELIVERY_SLOTS[s.delivery_slot]?.label ?? ''}</td>
          <td class="small">${s.last_run_at ? html`${formatDateTime(s.last_run_at)}${s.last_error ? html`<div style="color:var(--danger)">${s.last_error}</div>` : ''}` : html`<span class="muted">never</span>`}</td>
          <td>${s.is_active ? html`<span class="badge delivered">active</span>` : html`<span class="badge inactive">paused</span>`}</td>
          <td class="right">${canEdit ? html`<button class="btn small" data-toggle="${s.id}" data-active="${s.is_active}">${s.is_active ? 'Pause' : 'Resume'}</button>` : ''}</td></tr>`)}</tbody></table></div></div>`}`);
  }

  on(container, 'click', '[data-tab]', (_e, el) => { tab = el.dataset.tab; load().catch(reportError); });
  on(container, 'click', '#new-quote', () => quoteDialog(null));
  on(container, 'click', '[data-open]', (_e, b) => quoteDialog(quotes.find((q) => q.id === b.dataset.open)));
  on(container, 'click', '[data-send]', async (_e, b) => { try { await setQuoteStatus(b.dataset.send, 'sent'); toast('Quote sent — the customer sees it under Standing & quotes', 'success'); await load(); } catch (error) { reportError(error); } });
  on(container, 'click', '[data-withdraw]', async (_e, b) => { try { await setQuoteStatus(b.dataset.withdraw, 'draft'); toast('Quote withdrawn to draft', 'info'); await load(); } catch (error) { reportError(error); } });
  on(container, 'click', '[data-toggle]', async (_e, b) => { try { await setStandingOrderActive(b.dataset.toggle, b.dataset.active !== 'true'); await load(); } catch (error) { reportError(error); } });

  async function quoteDialog(existing) {
    const editable = canEdit && (!existing || existing.status === 'draft' || existing.status === 'sent');
    const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`, { title: existing ? existing.quote_number : 'New quote', wide: true });
    try {
      const [restaurants, products, outlets] = await Promise.all([listRestaurants(), listProducts(), listOutlets().catch(() => [])]);
      const active = products.filter((p) => p.is_active && !p.parent_product_id);
      const byId = Object.fromEntries(products.map((p) => [p.id, p]));
      const lines = existing ? existing.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price })) : [{ product_id: '', quantity: '', unit_price: '' }];
      let restaurantId = existing?.restaurant_id ?? '';
      const draw = () => {
        const sub = lines.reduce((t, l) => t + (Number(l.quantity) * Number(l.unit_price) || 0), 0);
        const myOutlets = outlets.filter((o) => o.restaurant_id === restaurantId && o.is_active);
        mount(el, html`<form id="quote-form" class="stack" novalidate>
          <div class="form-grid">
            <label class="field"><span class="label">Customer</span><select class="select" name="restaurant" required ${existing || !editable ? 'disabled' : ''}><option value="">Choose…</option>${restaurants.filter((r) => r.status === 'approved' || r.id === restaurantId).map((r) => html`<option value="${r.id}" ${r.id === restaurantId ? 'selected' : ''}>${r.name}</option>`)}</select></label>
            ${myOutlets.length > 1 ? html`<label class="field"><span class="label">Outlet</span><select class="select" name="outlet" ${editable ? '' : 'disabled'}><option value="">Primary</option>${myOutlets.map((o) => html`<option value="${o.id}" ${o.id === existing?.outlet_id ? 'selected' : ''}>${o.name}</option>`)}</select></label>` : ''}
            <label class="field"><span class="label">Valid until</span><input class="input" name="valid_until" type="date" value="${existing?.valid_until ?? isoDate(new Date(Date.now() + 7 * 86_400_000))}" required ${editable ? '' : 'disabled'}></label>
            <label class="field span-2"><span class="label">Notes to the customer</span><input class="input" name="notes" maxlength="1000" value="${existing?.notes ?? ''}" ${editable ? '' : 'disabled'}></label>
          </div>
          <table class="table small-table"><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Quoted price (₹)</th><th class="right">List</th><th class="right">Line</th><th></th></tr></thead>
            <tbody>${lines.map((l, i) => html`<tr data-line="${i}">
              <td><select class="select small" data-field="product_id" ${editable ? '' : 'disabled'}><option value="">Choose…</option>${active.map((p) => html`<option value="${p.id}" ${p.id === l.product_id ? 'selected' : ''}>${p.name} (${p.unit})</option>`)}</select></td>
              <td class="right"><input class="input small num right" type="number" min="0" step="any" data-field="quantity" value="${l.quantity}" style="width:90px" ${editable ? '' : 'disabled'}></td>
              <td class="right"><input class="input small num right" type="number" min="0" step="0.01" data-field="unit_price" value="${l.unit_price}" style="width:110px" ${editable ? '' : 'disabled'}></td>
              <td class="right muted small">${byId[l.product_id] ? formatINR(byId[l.product_id].price) : '—'}</td>
              <td class="right money">${formatINR(Number(l.quantity) * Number(l.unit_price) || 0)}</td>
              <td class="right">${editable ? html`<button type="button" class="btn ghost small" data-remove="${i}" ${lines.length === 1 ? 'disabled' : ''}>✕</button>` : ''}</td></tr>`)}</tbody>
            <tfoot><tr><td colspan="4" class="right muted">Subtotal before GST</td><td class="right money">${formatINR(sub)}</td><td></td></tr></tfoot></table>
          ${editable ? html`<div><button type="button" class="btn small" id="add-line">+ Add line</button></div>` : ''}
          <p class="form-error" id="quote-error" role="alert"></p>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Close</button>
            ${editable ? html`<button class="btn" type="submit" data-send="false">Save draft</button><button class="btn primary" type="submit" data-send="true">${existing?.status === 'sent' ? 'Save & resend' : 'Save & send'}</button>` : ''}</div>
        </form>`);
      };
      on(el, 'change', '[data-field]', (_e, input) => {
        const line = lines[Number(input.closest('[data-line]').dataset.line)];
        line[input.dataset.field] = input.value;
        if (input.dataset.field === 'product_id' && byId[input.value] && !line.unit_price) line.unit_price = byId[input.value].price;
        draw();
      });
      on(el, 'change', '[name="restaurant"]', (_e, sel) => { restaurantId = sel.value; draw(); });
      on(el, 'click', '#add-line', () => { lines.push({ product_id: '', quantity: '', unit_price: '' }); draw(); });
      on(el, 'click', '[data-remove]', (_e, b) => { lines.splice(Number(b.dataset.remove), 1); draw(); });
      let sendFlag = false;
      on(el, 'click', 'button[type="submit"]', (_e, b) => { sendFlag = b.dataset.send === 'true'; });
      draw();
      el.querySelector('#quote-form').onsubmit = async (event) => {
        event.preventDefault();
        const form = event.target;
        if (!restaurantId) { $('#quote-error', el).textContent = 'Choose a customer.'; return; }
        const items = lines.filter((l) => l.product_id && Number(l.quantity) > 0).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_price: Number(l.unit_price) }));
        if (!items.length || items.some((i) => !(i.unit_price >= 0))) { $('#quote-error', el).textContent = 'Add at least one line with a quantity and a price.'; return; }
        try {
          const r = await withBusy($('button[type="submit"][data-send="true"]', form), () => saveQuote({ id: existing?.id, restaurantId, items, validUntil: form.elements.valid_until.value, notes: form.elements.notes.value, outletId: form.elements.outlet?.value || null, send: sendFlag }));
          toast(`${r.quote_number} ${sendFlag ? 'sent' : 'saved'} — ${formatINR(r.total_amount)} incl. GST`, 'success'); close(); await load();
        } catch (error) { $('#quote-error', el).textContent = error.message; }
      };
    } catch (error) { close(); reportError(error); }
  }

  await load();
}
