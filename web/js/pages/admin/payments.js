// =============================================================================
// payments.js — Payments: receivables and receipts (migration 015).
//
//   #payments           Receivables: every customer with money open or on
//                       account, with ageing buckets (current / 1–30 / 31–60 /
//                       61–90 / 90+ days overdue). Click a customer to see the
//                       open invoices, apply credit on account, record a receipt,
//                       raise a debit note or open a statement.
//   #payments-receipts  Every receipt, newest first; void one (payments:approve).
//
// receiptDialog() is shared with the Orders screen ("Record payment" on a
// delivered order). Reads need payments:view; writes payments:edit; voiding
// payments:approve. The database re-checks all of it.
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { getReceivablesSummary, getCustomerReceivables, recordPayment, allocatePayment, voidPayment, raiseDebitNote,
         listPayments, listRestaurants, listSectors, listPaymentAllocations } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { RECEIPT_METHODS, webRoot, config } from '../../core/config.js';
import { fifoAllocate, agingTotals } from '../../core/receivables.js';
import { downloadCsv } from '../../core/csv.js';

/** Tab strip shared by the two payments screens. */
export function paymentsTabs(active) {
  const tabs = [{ href: '#payments', label: 'Receivables' }, { href: '#payments-receipts', label: 'Receipts' }];
  return html`<div class="tabs" role="tablist">${tabs.map((t) => html`<a role="tab" href="${t.href}" aria-selected="${String(t.href === active)}">${t.label}</a>`)}</div>`;
}

/** Today in India time as YYYY-MM-DD (receipts default to it). */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
/** First day of this month, YYYY-MM-DD. */
function monthStart() { return `${today().slice(0, 7)}-01`; }

// ---------- Receivables -------------------------------------------------------

export async function renderReceivables(container, me) {
  let search = '';
  let [rows, sectors] = await Promise.all([getReceivablesSummary(), listSectors()]);
  const sectorName = Object.fromEntries(sectors.map((s) => [s.code, s.name]));

  async function reload() { rows = await getReceivablesSummary(); draw(); }

  function draw() {
    const term = search.trim().toLowerCase();
    const shown = rows.filter((r) => !term || r.name.toLowerCase().includes(term));
    const t = agingTotals(shown);
    mount(container, html`
      <div class="page-head"><div><h1>Payments</h1><p>${formatINR(t.outstanding)} outstanding · ${formatINR(t.overdue)} overdue · ${shown.length} customer${shown.length === 1 ? '' : 's'}</p></div>
        <div class="row">
          ${can(me, 'payments', 'edit') ? html`<button class="btn primary" id="new-receipt">Record receipt</button>` : ''}
          ${can(me, 'payments', 'export') ? html`<button class="btn" id="export">Export CSV</button>` : ''}
        </div></div>
      ${paymentsTabs('#payments')}
      <div class="toolbar"><input class="input search" id="search" type="search" placeholder="Search customer…" value="${search}"></div>
      <div class="card"><div class="table-wrap"><table class="table aging">
        <thead><tr><th>Customer</th><th class="right">Outstanding</th><th class="right">Current</th><th class="right">1–30</th><th class="right">31–60</th><th class="right">61–90</th><th class="right">90+</th><th class="right">On account</th><th class="right">Credit limit</th><th></th></tr></thead>
        <tbody>${shown.length === 0 ? html`<tr><td colspan="10"><div class="empty">Nothing is owed right now.</div></td></tr>`
          : shown.map((r) => html`<tr class="clickable" data-customer="${r.restaurant_id}">
            <td><strong>${r.name}</strong><div class="muted tiny">${sectorName[r.sector_code] ?? r.sector_code} · ${r.credit_days} credit days${r.oldest_due ? ` · oldest due ${formatDate(r.oldest_due)}` : ''}</div></td>
            <td class="right money ${Number(r.outstanding) < 0 ? 'negative' : ''}">${formatINR(r.outstanding)}</td>
            <td class="right bucket">${formatINR(r.current_due)}</td>
            <td class="right bucket ${Number(r.d1_30) > 0 ? 'overdue' : ''}">${formatINR(r.d1_30)}</td>
            <td class="right bucket ${Number(r.d31_60) > 0 ? 'overdue' : ''}">${formatINR(r.d31_60)}</td>
            <td class="right bucket ${Number(r.d61_90) > 0 ? 'overdue' : ''}">${formatINR(r.d61_90)}</td>
            <td class="right bucket ${Number(r.d90_plus) > 0 ? 'overdue' : ''}">${formatINR(r.d90_plus)}</td>
            <td class="right num">${Number(r.unapplied_credit) > 0 ? formatINR(r.unapplied_credit) : html`<span class="muted">—</span>`}</td>
            <td class="right num">${r.credit_limit == null ? html`<span class="muted">none</span>` : formatINR(r.credit_limit)}</td>
            <td class="right"><button class="btn small" data-open="${r.restaurant_id}">Open</button></td></tr>`)}
        </tbody>
        ${shown.length ? html`<tfoot><tr><td><strong>Total</strong></td><td class="right money">${formatINR(t.outstanding)}</td><td class="right num">${formatINR(t.current_due)}</td>
          <td class="right num">${formatINR(t.d1_30)}</td><td class="right num">${formatINR(t.d31_60)}</td><td class="right num">${formatINR(t.d61_90)}</td><td class="right num">${formatINR(t.d90_plus)}</td>
          <td class="right num">${formatINR(t.unapplied_credit)}</td><td></td><td></td></tr></tfoot>` : ''}
      </table></div></div>
      <p class="muted small" style="margin-top:var(--space-3)">An invoice is a delivered order; it falls due after the customer's credit days (cash on delivery: the delivery day). Credit notes and receipts apply oldest-due-first; "on account" is money not yet applied to an invoice.</p>`);
    const input = $('#search', container);
    input.oninput = () => { search = input.value; draw(); $('#search', container).focus(); };
  }

  // The Open button and the row itself both open the account (closest() picks the button when it was clicked).
  on(container, 'click', '[data-open], [data-customer]', (_e, el) => customerDrawer(el.dataset.open ?? el.dataset.customer, me, reload));
  on(container, 'click', '#new-receipt', async () => {
    try {
      const restaurants = (await listRestaurants()).filter((r) => r.status === 'approved');
      pickCustomer(restaurants, (r) => receiptDialog({ restaurantId: r.id, restaurantName: r.name }, me, reload));
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '#export', () => downloadCsv('receivables.csv', rows, [
    { key: 'name', label: 'Customer' }, { label: 'Sector', value: (r) => sectorName[r.sector_code] ?? r.sector_code },
    { key: 'outstanding', label: 'Outstanding' }, { key: 'current_due', label: 'Current' }, { key: 'd1_30', label: '1-30 days' },
    { key: 'd31_60', label: '31-60 days' }, { key: 'd61_90', label: '61-90 days' }, { key: 'd90_plus', label: '90+ days' },
    { key: 'overdue', label: 'Overdue' }, { key: 'unapplied_credit', label: 'On account' }, { key: 'credit_limit', label: 'Credit limit' },
    { key: 'credit_days', label: 'Credit days' }, { key: 'oldest_due', label: 'Oldest due' },
  ]));

  draw();
}

/** Choose a customer before recording a receipt from the list screen. */
function pickCustomer(restaurants, onPick) {
  const { el, close } = openModal(html`
    <form id="pick" class="stack">
      <label class="field"><span class="label">Customer</span><select class="select" name="restaurant" required>
        <option value="">Choose…</option>${restaurants.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Next</button></div>
    </form>`, { title: 'Record a receipt' });
  $('#pick', el).onsubmit = (event) => {
    event.preventDefault();
    const r = restaurants.find((x) => x.id === event.target.elements.restaurant.value);
    if (!r) return;
    close(); onPick(r);
  };
}

/** One customer's position: open items, credit on account, receipts; actions. */
async function customerDrawer(restaurantId, me, onChanged) {
  const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`, { title: 'Customer account', wide: true });
  const canEdit = can(me, 'payments', 'edit');
  const canVoid = can(me, 'payments', 'approve');
  let acc; let receipts;

  async function load() {
    [acc, receipts] = await Promise.all([getCustomerReceivables(restaurantId), listPayments({ restaurantId, limit: 20 })]);
    draw();
  }

  function draw() {
    const overLimit = acc.credit_limit != null && Number(acc.exposure) > Number(acc.credit_limit);
    mount(el, html`
      <div class="spread"><h2 style="margin:0">${acc.name}</h2>
        <a class="btn small" target="_blank" rel="noopener" href="${webRoot}statement.html?customer=${restaurantId}&from=${monthStart()}&to=${today()}">Statement</a></div>
      <div class="stat-grid" style="margin:var(--space-4) 0">
        <div class="card stat"><div class="stat-label">Outstanding</div><div class="stat-value">${formatINR(acc.outstanding)}</div></div>
        <div class="card stat"><div class="stat-label">Overdue</div><div class="stat-value" style="${Number(acc.overdue) > 0 ? 'color:var(--danger)' : ''}">${formatINR(acc.overdue)}</div></div>
        <div class="card stat"><div class="stat-label">On account</div><div class="stat-value">${formatINR(acc.unapplied_credit)}</div></div>
        <div class="card stat"><div class="stat-label">Credit limit</div><div class="stat-value">${acc.credit_limit == null ? 'none' : formatINR(acc.credit_limit)}</div>
          ${acc.credit_limit == null ? '' : html`<div class="stat-note" style="${overLimit ? 'color:var(--danger)' : ''}">${formatINR(acc.credit_available)} available${Number(acc.pending_credit_orders) > 0 ? html` · ${formatINR(acc.pending_credit_orders)} on the way` : ''}</div>`}</div>
      </div>

      <h3>Open invoices &amp; debit notes</h3>
      <div class="table-wrap"><table class="table small-table">
        <thead><tr><th>Item</th><th>Date</th><th>Due</th><th class="right">Amount</th><th class="right">Paid</th><th class="right">Balance</th></tr></thead>
        <tbody>${acc.open_items.length === 0 ? html`<tr><td colspan="6"><div class="empty">Nothing open.</div></td></tr>` : acc.open_items.map((i) => html`<tr>
          <td><strong>${i.number}</strong><div class="muted tiny">${i.kind === 'order' ? (i.method === 'credit' ? 'pay later' : 'cash on delivery') : i.method}</div></td>
          <td class="nowrap">${formatDate(i.item_date)}</td>
          <td class="nowrap">${formatDate(i.due_date)}${Number(i.days_overdue) > 0 ? html`<div class="tiny" style="color:var(--danger)">${i.days_overdue} day${Number(i.days_overdue) === 1 ? '' : 's'} overdue</div>` : ''}</td>
          <td class="right num">${formatINR(i.amount)}</td><td class="right num">${formatINR(i.allocated)}</td><td class="right money">${formatINR(i.balance)}</td></tr>`)}</tbody></table></div>

      ${acc.unapplied.length ? html`<h3 style="margin-top:var(--space-4)">On account (not yet applied)</h3>
        <div class="table-wrap"><table class="table small-table"><tbody>${acc.unapplied.map((u) => html`<tr>
          <td><strong>${u.number}</strong> <span class="muted tiny">${u.kind === 'payment' ? 'receipt' : 'credit note'} · ${formatDate(u.item_date)}</span></td>
          <td class="right money">${formatINR(u.balance)}</td>
          <td class="right">${canEdit && u.kind === 'payment' && acc.open_items.length ? html`<button class="btn small" data-apply="${u.id}" data-max="${u.balance}" data-number="${u.number}">Apply</button>` : ''}</td></tr>`)}</tbody></table></div>
        <p class="muted tiny">Credit notes and receipts apply themselves to pay-later invoices. A cash-on-delivery invoice is covered by the driver's cash receipt at delivery; if no cash was collected, void that receipt, then apply the credit here.</p>` : ''}

      <h3 style="margin-top:var(--space-4)">Recent receipts</h3>
      <div class="table-wrap"><table class="table small-table">
        <tbody>${receipts.length === 0 ? html`<tr><td><div class="empty">No receipts yet.</div></td></tr>` : receipts.map((p) => html`<tr style="${p.voided_at ? 'opacity:.55' : ''}">
          <td><strong>${p.receipt_number}</strong><div class="muted tiny">${RECEIPT_METHODS[p.method]?.label ?? p.method}${p.reference ? ` · ${p.reference}` : ''}${p.note ? ` · ${p.note}` : ''}${p.voided_at ? html` · <span style="color:var(--danger)">void: ${p.void_reason}</span>` : ''}</div></td>
          <td class="nowrap muted">${formatDate(p.received_on)}</td>
          <td class="right money">${formatINR(p.amount)}</td>
          <td class="right">${canVoid && !p.voided_at ? html`<button class="btn ghost small" data-void="${p.id}" data-number="${p.receipt_number}">Void</button>` : ''}</td></tr>`)}</tbody></table></div>

      <div class="row" style="justify-content:flex-end;margin-top:var(--space-5)">
        ${canEdit ? html`<button class="btn" data-debit>Raise debit note</button><button class="btn primary" data-receipt>Record receipt</button>` : ''}
      </div>`);
  }

  try { await load(); } catch (error) { close(); reportError(error); return; }

  const changed = async () => { await load(); onChanged?.(); };
  on(el, 'click', '[data-receipt]', () => receiptDialog({ restaurantId, restaurantName: acc.name, openItems: acc.open_items }, me, changed));
  on(el, 'click', '[data-debit]', () => debitNoteDialog(restaurantId, acc.name, changed));
  on(el, 'click', '[data-apply]', (_e, b) => allocateDialog({ paymentId: b.dataset.apply, number: b.dataset.number, max: Number(b.dataset.max), openItems: acc.open_items }, changed));
  on(el, 'click', '[data-void]', (_e, b) => voidDialog(b.dataset.void, b.dataset.number, changed));
}

// ---------- Dialogs -------------------------------------------------------------

/**
 * Record a receipt for one customer. Open items are offered for allocation by
 * hand (ticked = apply); with none ticked the database applies oldest-due-first,
 * and the preview under the amount shows what that will cover.
 *   receiptDialog({ restaurantId, restaurantName, openItems?, prefill?: { amount, orderId } }, me, onSaved)
 */
export async function receiptDialog({ restaurantId, restaurantName, openItems, prefill = {} }, me, onSaved) {
  if (!openItems) {
    try { openItems = (await getCustomerReceivables(restaurantId)).open_items; } catch (error) { reportError(error); return; }
  }
  const { el, close } = openModal(html`
    <form id="receipt" class="stack" novalidate>
      <div class="form-grid">
        <label class="field"><span class="label">Amount (₹)</span><input class="input num" name="amount" type="number" min="0.01" step="0.01" value="${prefill.amount ?? ''}" required></label>
        <label class="field"><span class="label">Method</span><select class="select" name="method">${Object.entries(RECEIPT_METHODS).filter(([k]) => k !== 'online').map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
        <label class="field"><span class="label">Reference</span><input class="input" name="reference" maxlength="60" placeholder="UTR / cheque no."><span class="hint" id="ref-hint">Needed for UPI, bank transfer and cheque.</span></label>
        <label class="field"><span class="label">Received on</span><input class="input" name="received_on" type="date" value="${today()}" max="${today()}"></label>
        <label class="field span-2"><span class="label">Note</span><input class="input" name="note" maxlength="300" placeholder="Optional"></label>
      </div>
      ${openItems.length ? html`<div class="field"><span class="label">Apply to</span>
        <div class="table-wrap"><table class="table small-table"><tbody>${openItems.map((i) => html`<tr>
          <td><label class="check small"><input type="checkbox" data-item="${i.id}" data-kind="${i.kind}" data-balance="${i.balance}" ${prefill.orderId === i.id ? 'checked' : ''}> ${i.number}</label></td>
          <td class="muted small">due ${formatDate(i.due_date)}</td><td class="right num">${formatINR(i.balance)}</td></tr>`)}</tbody></table></div>
        <span class="hint" id="apply-hint"></span></div>` : html`<p class="muted small">No open invoice yet: the receipt stays on account and applies to the next pay-later invoice.</p>`}
      <p class="form-error" id="receipt-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save receipt</button></div>
    </form>`, { title: `Receipt from ${restaurantName}`, wide: true });

  const form = $('#receipt', el);
  function previewHint() {
    const hint = $('#apply-hint', el);
    if (!hint) return;
    const ticked = [...form.querySelectorAll('[data-item]:checked')];
    const amount = Number(form.elements.amount.value) || 0;
    if (ticked.length) {
      const total = ticked.reduce((s, b) => s + Number(b.dataset.balance), 0);
      hint.textContent = `Applied to the ticked items (${formatINR(Math.min(amount, total))}); ${amount > total ? `${formatINR(amount - total)} stays on account.` : 'each item takes at most its balance.'}`;
    } else {
      const { lines, leftover } = fifoAllocate(amount, openItems.filter((i) => i.method !== 'cod' || i.kind !== 'order'));
      hint.textContent = lines.length ? `Oldest due first: ${lines.map((l) => `${l.number} ${formatINR(l.amount)}`).join(', ')}${leftover > 0 ? `; ${formatINR(leftover)} on account` : ''}.`
        : 'Nothing ticked: applies oldest-due-first to pay-later invoices (cash-on-delivery invoices only by ticking them).';
    }
  }
  on(el, 'input', '[name=amount]', previewHint);
  on(el, 'change', '[data-item]', previewHint);
  on(el, 'change', '[name=method]', (_e, sel) => { $('#ref-hint', el).textContent = RECEIPT_METHODS[sel.value]?.needsReference ? 'Required for this method.' : 'Optional for this method.'; });
  previewHint();

  form.onsubmit = async (event) => {
    event.preventDefault();
    const amount = Number(form.elements.amount.value);
    if (!amount || amount <= 0) { $('#receipt-error', el).textContent = 'Enter the amount received.'; return; }
    const method = form.elements.method.value;
    if (RECEIPT_METHODS[method]?.needsReference && !form.elements.reference.value.trim()) { $('#receipt-error', el).textContent = 'Enter the UTR / transaction or cheque number.'; return; }
    // Ticked items get the receipt in the order shown, each up to its balance.
    let left = amount;
    const allocations = [];
    for (const box of form.querySelectorAll('[data-item]:checked')) {
      const take = Math.min(left, Number(box.dataset.balance));
      if (take <= 0) break;
      allocations.push(box.dataset.kind === 'order' ? { order_id: box.dataset.item, amount: take } : { debit_note_id: box.dataset.item, amount: take });
      left -= take;
    }
    try {
      const r = await withBusy($('button[type="submit"]', form), () => recordPayment(restaurantId, {
        amount, method, reference: form.elements.reference.value, receivedOn: form.elements.received_on.value, note: form.elements.note.value, allocations,
      }));
      toast(`${r.receipt_number} saved${Number(r.unallocated) > 0 ? ` · ${formatINR(r.unallocated)} on account` : ''}`, 'success');
      close(); onSaved?.();
    } catch (error) { $('#receipt-error', el).textContent = error.message; }
  };
}

/** Apply an unapplied receipt to chosen open items. */
function allocateDialog({ paymentId, number, max, openItems }, onSaved) {
  const { el, close } = openModal(html`
    <form id="allocate" class="stack" novalidate>
      <p>${formatINR(max)} of <strong>${number}</strong> is on account. Tick what it should pay, oldest first.</p>
      <div class="table-wrap"><table class="table small-table"><tbody>${openItems.map((i) => html`<tr>
        <td><label class="check small"><input type="checkbox" data-item="${i.id}" data-kind="${i.kind}" data-balance="${i.balance}"> ${i.number}</label></td>
        <td class="muted small">due ${formatDate(i.due_date)}</td><td class="right num">${formatINR(i.balance)}</td></tr>`)}</tbody></table></div>
      <p class="form-error" id="allocate-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Apply</button></div>
    </form>`, { title: 'Apply receipt' });
  $('#allocate', el).onsubmit = async (event) => {
    event.preventDefault();
    let left = max;
    const allocations = [];
    for (const box of event.target.querySelectorAll('[data-item]:checked')) {
      const take = Math.min(left, Number(box.dataset.balance));
      if (take <= 0) break;
      allocations.push(box.dataset.kind === 'order' ? { order_id: box.dataset.item, amount: take } : { debit_note_id: box.dataset.item, amount: take });
      left -= take;
    }
    if (!allocations.length) { $('#allocate-error', el).textContent = 'Tick at least one item.'; return; }
    try {
      await withBusy($('button[type="submit"]', event.target), () => allocatePayment(paymentId, allocations));
      toast('Receipt applied', 'success'); close(); onSaved?.();
    } catch (error) { $('#allocate-error', el).textContent = error.message; }
  };
}

function debitNoteDialog(restaurantId, name, onSaved) {
  const { el, close } = openModal(html`
    <form id="debit" class="stack" novalidate>
      <p class="muted small">An extra charge to <strong>${name}</strong> (crate not returned, late fee…). It becomes an open item like an invoice.</p>
      <div class="form-grid">
        <label class="field"><span class="label">Amount (₹)</span><input class="input num" name="amount" type="number" min="0.01" step="0.01" required></label>
        <label class="field"><span class="label">Due on</span><input class="input" name="due_date" type="date" value="${today()}"></label>
        <label class="field span-2"><span class="label">Reason</span><input class="input" name="reason" maxlength="300" required></label>
      </div>
      <p class="form-error" id="debit-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Raise debit note</button></div>
    </form>`, { title: 'Debit note' });
  $('#debit', el).onsubmit = async (event) => {
    event.preventDefault();
    const f = event.target.elements;
    if (!Number(f.amount.value) || !f.reason.value.trim()) { $('#debit-error', el).textContent = 'Enter an amount and a reason.'; return; }
    try {
      const r = await withBusy($('button[type="submit"]', event.target), () => raiseDebitNote(restaurantId, { amount: f.amount.value, reason: f.reason.value, dueDate: f.due_date.value }));
      toast(`${r.debit_note_number} raised`, 'success'); close(); onSaved?.();
    } catch (error) { $('#debit-error', el).textContent = error.message; }
  };
}

async function voidDialog(paymentId, number, onSaved) {
  const { el, close } = openModal(html`
    <form id="void" class="stack" novalidate>
      <p>Void <strong>${number}</strong>? Its invoices open again. The receipt stays on record, marked void.</p>
      <label class="field"><span class="label">Reason</span><input class="input" name="reason" maxlength="300" required placeholder="Cheque bounced, wrong customer…"></label>
      <p class="form-error" id="void-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn danger" type="submit">Void receipt</button></div>
    </form>`, { title: 'Void receipt' });
  $('#void', el).onsubmit = async (event) => {
    event.preventDefault();
    const reason = event.target.elements.reason.value.trim();
    if (!reason) { $('#void-error', el).textContent = 'Give a reason.'; return; }
    try {
      await withBusy($('button[type="submit"]', event.target), () => voidPayment(paymentId, reason));
      toast(`${number} voided`, 'success'); close(); onSaved?.();
    } catch (error) { $('#void-error', el).textContent = error.message; }
  };
}

// ---------- Receipts list -------------------------------------------------------

export async function renderPaymentReceipts(container, me) {
  const canVoid = can(me, 'payments', 'approve');
  let receipts = await listPayments({ limit: 300 });

  async function reload() { receipts = await listPayments({ limit: 300 }); draw(); }

  function draw() {
    const live = receipts.filter((p) => !p.voided_at);
    const total = live.reduce((s, p) => s + Number(p.amount), 0);
    mount(container, html`
      <div class="page-head"><div><h1>Receipts</h1><p>${live.length} receipt${live.length === 1 ? '' : 's'} · ${formatINR(total)}</p></div>
        <div class="row">
          ${can(me, 'payments', 'edit') ? html`<button class="btn primary" id="new-receipt">Record receipt</button>` : ''}
          ${can(me, 'payments', 'export') ? html`<button class="btn" id="export">Export CSV</button>` : ''}
        </div></div>
      ${paymentsTabs('#payments-receipts')}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Receipt</th><th>Customer</th><th>Method</th><th>Received</th><th class="right">Amount</th><th></th></tr></thead>
        <tbody>${receipts.length === 0 ? html`<tr><td colspan="6"><div class="empty">No receipts yet. Cash collected on delivery appears here automatically.</div></td></tr>`
          : receipts.map((p) => html`<tr style="${p.voided_at ? 'opacity:.55' : ''}">
            <td><strong>${p.receipt_number}</strong>${p.voided_at ? html` <span class="badge cancelled">void</span>` : ''}${p.note ? html`<div class="muted tiny">${p.note}</div>` : ''}</td>
            <td>${p.restaurants?.name ?? '—'}</td>
            <td class="small">${RECEIPT_METHODS[p.method]?.label ?? p.method}${p.reference ? html`<div class="muted tiny">${p.reference}</div>` : ''}</td>
            <td class="nowrap muted">${formatDate(p.received_on)}</td>
            <td class="right money">${formatINR(p.amount)}</td>
            <td class="right nowrap"><button class="btn small" data-detail="${p.id}">Applied to</button>
              ${canVoid && !p.voided_at ? html`<button class="btn ghost small" data-void="${p.id}" data-number="${p.receipt_number}">Void</button>` : ''}</td></tr>`)}
        </tbody></table></div></div>`);
  }

  on(container, 'click', '#new-receipt', async () => {
    try {
      const restaurants = (await listRestaurants()).filter((r) => r.status === 'approved');
      pickCustomer(restaurants, (r) => receiptDialog({ restaurantId: r.id, restaurantName: r.name }, me, reload));
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '[data-void]', (_e, b) => voidDialog(b.dataset.void, b.dataset.number, reload));
  on(container, 'click', '[data-detail]', async (_e, b) => {
    try {
      const rows = await listPaymentAllocations({ paymentId: b.dataset.detail });
      const p = receipts.find((x) => x.id === b.dataset.detail);
      const applied = rows.reduce((s, a) => s + Number(a.amount), 0);
      openModal(html`<div class="stack">
        ${rows.length === 0 ? html`<p class="muted">Not applied to any invoice yet (on account).</p>`
          : html`<table class="table small-table"><tbody>${rows.map((a) => html`<tr><td>${a.orders?.order_number ?? a.debit_notes?.debit_note_number ?? '—'}</td><td class="right money">${formatINR(a.amount)}</td></tr>`)}</tbody></table>`}
        <p class="muted small">${formatINR(applied)} applied of ${formatINR(p.amount)}.</p>
        <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div></div>`, { title: `${p.receipt_number} · applied to` });
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '#export', () => downloadCsv('receipts.csv', receipts, [
    { key: 'receipt_number', label: 'Receipt' }, { label: 'Customer', value: (p) => p.restaurants?.name ?? '' }, { key: 'method', label: 'Method' },
    { key: 'reference', label: 'Reference' }, { key: 'received_on', label: 'Received on' }, { key: 'amount', label: 'Amount' },
    { key: 'note', label: 'Note' }, { label: 'Void', value: (p) => (p.voided_at ? p.void_reason : '') },
  ]));

  draw();
}
