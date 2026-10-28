// =============================================================================
// payments.js — the customer's money page (migration 015): what they owe, what
// is overdue, their credit limit, every open invoice, receipts and credit notes,
// a statement for any month, and — when Razorpay is configured in config.js —
// a "Pay online" button. Everything here is read through customer_receivables /
// customer_statement, which only return the signed-in customer's own account.
// =============================================================================

import { html, mount, on, formatINR, formatDate, reportError, toast, withBusy, openModal } from '../../core/ui.js';
import { getCustomerReceivables, listPayments, listCreditNotes, createOnlinePaymentOrder } from '../../core/api.js';
import { RECEIPT_METHODS, webRoot, config } from '../../core/config.js';

/** YYYY-MM-DD today in India time, and the first of this month. */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export async function renderPayments(container, state) {
  const restaurant = state.me.restaurant;
  if (!restaurant) { mount(container, html`<div class="empty">No customer account is linked to this login.</div>`); return; }

  const [acc, receipts, credits] = await Promise.all([
    getCustomerReceivables(restaurant.id), listPayments({ restaurantId: restaurant.id, limit: 50 }), listCreditNotes({ restaurantId: restaurant.id, limit: 50 }),
  ]);
  const month = today().slice(0, 7);
  const canPayOnline = Boolean(config.razorpayKeyId) && Number(acc.outstanding) > 0;

  mount(container, html`
    <div class="page-head"><div><h1>Payments</h1><p>${restaurant.name}</p></div>
      ${canPayOnline ? html`<button class="btn primary" id="pay-online">Pay ${formatINR(acc.outstanding)} online</button>` : ''}</div>
    <div class="stat-grid">
      <div class="card stat"><div class="stat-label">You owe</div><div class="stat-value">${formatINR(Math.max(acc.outstanding, 0))}</div>
        ${Number(acc.outstanding) < 0 ? html`<div class="stat-note">${formatINR(-acc.outstanding)} in your favour</div>` : ''}</div>
      <div class="card stat"><div class="stat-label">Overdue</div><div class="stat-value" style="${Number(acc.overdue) > 0 ? 'color:var(--danger)' : ''}">${formatINR(acc.overdue)}</div>
        ${Number(acc.overdue) > 0 ? html`<div class="stat-note">Settle this to keep ordering on credit</div>` : ''}</div>
      <div class="card stat"><div class="stat-label">Credit limit</div><div class="stat-value">${acc.credit_limit == null ? 'No limit' : formatINR(acc.credit_limit)}</div>
        ${acc.credit_limit == null ? '' : html`<div class="stat-note">${formatINR(acc.credit_available)} available</div>`}</div>
      <div class="card stat"><div class="stat-label">On account</div><div class="stat-value">${formatINR(acc.unapplied_credit)}</div><div class="stat-note">credit not yet applied to an invoice</div></div>
    </div>

    <section class="card" style="margin-top:var(--space-5)">
      <div class="card-head"><h2>Open invoices</h2><span class="muted small">${acc.open_items.length} open</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th class="right">Amount</th><th class="right">Balance</th><th></th></tr></thead>
        <tbody>${acc.open_items.length === 0 ? html`<tr><td colspan="6"><div class="empty">Nothing to pay right now.</div></td></tr>` : acc.open_items.map((i) => html`<tr>
          <td><strong>${i.number}</strong><div class="muted tiny">${i.kind === 'order' ? (i.method === 'credit' ? 'pay later' : 'cash on delivery') : `debit note: ${i.method}`}</div></td>
          <td class="nowrap">${formatDate(i.item_date)}</td>
          <td class="nowrap">${formatDate(i.due_date)}${Number(i.days_overdue) > 0 ? html`<div class="tiny" style="color:var(--danger)">${i.days_overdue} day${Number(i.days_overdue) === 1 ? '' : 's'} overdue</div>` : ''}</td>
          <td class="right num">${formatINR(i.amount)}</td><td class="right money">${formatINR(i.balance)}</td>
          <td class="right">${i.kind === 'order' ? html`<a class="btn small" target="_blank" rel="noopener" href="${webRoot}invoice.html?order=${i.id}">Invoice</a>` : ''}</td></tr>`)}</tbody></table></div>
    </section>

    <div class="form-grid" style="margin-top:var(--space-5);align-items:start">
      <section class="card">
        <div class="card-head"><h2>Receipts</h2></div>
        <div class="table-wrap"><table class="table"><tbody>${receipts.filter((p) => !p.voided_at).length === 0 ? html`<tr><td><div class="empty">No payments recorded yet.</div></td></tr>`
          : receipts.filter((p) => !p.voided_at).map((p) => html`<tr><td><strong>${p.receipt_number}</strong><div class="muted tiny">${RECEIPT_METHODS[p.method]?.label ?? p.method}${p.reference ? ` · ${p.reference}` : ''}</div></td>
            <td class="nowrap muted">${formatDate(p.received_on)}</td><td class="right money">${formatINR(p.amount)}</td></tr>`)}</tbody></table></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Credit notes</h2></div>
        <div class="table-wrap"><table class="table"><tbody>${credits.length === 0 ? html`<tr><td><div class="empty">No credit notes.</div></td></tr>`
          : credits.map((c) => html`<tr><td><strong>${c.credit_note_number}</strong><div class="muted tiny">${c.reason ?? ''}${c.orders?.order_number ? ` · ${c.orders.order_number}` : ''}</div></td>
            <td class="nowrap muted">${formatDate(c.created_at)}</td><td class="right money">${formatINR(c.amount)}</td></tr>`)}</tbody></table></div>
      </section>
    </div>

    <form class="card card-pad row" id="statement" style="margin-top:var(--space-5);align-items:flex-end">
      <label class="field"><span class="label">Statement for</span><input class="input" type="month" name="month" value="${month}" max="${month}"></label>
      <button class="btn" type="submit">Open statement</button>
      <span class="muted small">Opens a printable statement with every invoice, receipt and credit note of that month and the running balance.</span>
    </form>`);

  on(container, 'submit', '#statement', (event, form) => {
    event.preventDefault();
    const m = form.elements.month.value || month;
    const from = `${m}-01`;
    const last = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
    const to = `${m}-${String(last).padStart(2, '0')}`;
    window.open(`${webRoot}statement.html?customer=${restaurant.id}&from=${from}&to=${to}`, '_blank', 'noopener');
  });

  on(container, 'click', '#pay-online', (_e, button) => payOnline(button, acc, restaurant));
}

/**
 * Razorpay checkout: the razorpay-order Edge Function creates the gateway order
 * (it holds the secret); Razorpay's checkout script takes the card / UPI; the
 * razorpay-webhook function records the receipt. Nothing here can mark anything
 * paid — only the signed webhook can.
 */
async function payOnline(button, acc, restaurant) {
  try {
    const order = await withBusy(button, () => createOnlinePaymentOrder(acc.outstanding));
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    const rzp = new window.Razorpay({
      key: order.key_id || config.razorpayKeyId,
      amount: order.amount, currency: order.currency || 'INR', order_id: order.order_id,
      name: config.appName, description: `Account ${restaurant.name}`,
      prefill: { name: restaurant.name, contact: restaurant.phone || '' },
      notes: { restaurant_id: restaurant.id },
      handler: () => {
        openModal(html`<p>Thank you. Your payment is being confirmed; it shows under Receipts within a minute.</p>
          <div class="row" style="justify-content:flex-end"><button class="btn primary" data-close>OK</button></div>`, { title: 'Payment sent' });
        toast('Payment sent', 'success');
      },
    });
    rzp.open();
  } catch (error) { reportError(error); }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the payment page. Check your connection.'));
    document.head.append(s);
  });
}
