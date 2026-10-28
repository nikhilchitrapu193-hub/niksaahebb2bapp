// =============================================================================
// invoice.js — printable GST tax invoice for one order (?order=<uuid>).
// Works for the restaurant that placed it and for admins: Row Level Security
// decides whether the order can be read at all, so no extra checks are needed.
// =============================================================================

import { html, mount, $, formatINR, formatQty, formatDate, formatDateTime } from '../core/ui.js';
import { loadCurrentUser, loginFor } from '../core/auth.js';
import { getOrder, getCompanySettings } from '../core/api.js';
import { PAYMENT_METHODS, DELIVERY_SLOTS } from '../core/config.js';

const root = $('#invoice');
const orderId = new URLSearchParams(location.search).get('order');

async function render() {
  const me = await loadCurrentUser();
  if (!me?.profile) { location.replace(loginFor('restaurant')); return; }

  const [order, company] = await Promise.all([getOrder(orderId), getCompanySettings()]);
  if (!order) { mount(root, html`<div class="empty"><strong>Order not found</strong>It may belong to another account.</div>`); return; }

  // Restaurant details are snapshotted on the order; GSTIN comes from the live row for own orders.
  const buyerGstin = me.restaurant?.gstin ?? '';

  // Group tax by rate, as GST invoices normally show.
  const byRate = {};
  for (const i of order.order_items) {
    const r = Number(i.gst_rate);
    byRate[r] = (byRate[r] ?? 0) + Number(i.tax_amount);
  }

  document.title = `Invoice ${order.order_number} — ${company.name}`;
  mount(root, html`
    <div class="invoice-head">
      <div><h1>${company.name}</h1>
        <div class="muted small">${company.address}</div>
        <div class="muted small">${company.phone ? html`${company.phone} · ` : ''}${company.email}</div>
        <div class="small">${company.gstin ? html`GSTIN ${company.gstin}` : ''}${company.fssai ? html` · FSSAI ${company.fssai}` : ''}</div></div>
      <div class="right"><h2>Tax Invoice</h2>
        <div><strong>${order.order_number}</strong></div>
        <div class="muted small">Order date ${formatDate(order.created_at)}</div>
        <div class="muted small">Delivery ${formatDate(order.delivery_date)} · ${DELIVERY_SLOTS[order.delivery_slot]?.label ?? ''}</div>
        <div class="small">${order.payment_status === 'paid' ? html`<span class="badge approved">Paid</span> ${formatDate(order.paid_at)}` : html`<span class="badge pending">Unpaid · ${PAYMENT_METHODS[order.payment_method]?.label ?? ''}</span>${order.due_date ? html` due ${formatDate(order.due_date)}` : ''}`}</div></div>
    </div>

    <div class="parties">
      <div><h3>Bill to</h3><strong>${order.restaurant_name}</strong>
        <div class="small">${order.delivery_address}</div>
        <div class="small muted">${order.contact_phone ?? ''}</div>
        ${buyerGstin ? html`<div class="small">GSTIN ${buyerGstin}</div>` : ''}</div>
      <div><h3>Ship to</h3><div class="small">${order.delivery_address}</div></div>
    </div>

    <table class="table">
      <thead><tr><th>#</th><th>Item</th><th>HSN</th><th class="right">Qty</th><th class="right">Rate</th><th class="right">Amount</th><th class="right">GST</th><th class="right">Tax</th></tr></thead>
      <tbody>${order.order_items.map((i, n) => html`<tr>
        <td class="muted">${n + 1}</td><td>${i.product_name}</td><td class="muted num">${i.hsn_code ?? ''}</td>
        <td class="right num">${formatQty(i.quantity)} ${i.unit}${i.ordered_quantity != null && Number(i.ordered_quantity) !== Number(i.quantity) ? html`<div class="muted tiny">ordered ${formatQty(i.ordered_quantity)}</div>` : ''}</td>
        <td class="right num">${formatINR(i.unit_price)}</td>
        <td class="right num">${formatINR(i.line_total)}</td>
        <td class="right num">${Number(i.gst_rate)}%</td>
        <td class="right num">${formatINR(i.tax_amount)}</td></tr>`)}</tbody>
    </table>

    <table class="table totals">
      <tr><td class="muted">Taxable value</td><td class="right num">${formatINR(order.subtotal)}</td></tr>
      ${Number(order.delivery_fee) > 0 ? html`<tr><td class="muted">Delivery fee</td><td class="right num">${formatINR(order.delivery_fee)}</td></tr>` : ''}
      ${Object.entries(byRate).filter(([r]) => Number(r) > 0).map(([r, amt]) => html`
        <tr><td class="muted">CGST ${Number(r) / 2}%</td><td class="right num">${formatINR(amt / 2)}</td></tr>
        <tr><td class="muted">SGST ${Number(r) / 2}%</td><td class="right num">${formatINR(amt / 2)}</td></tr>`)}
      <tr><td><strong>Grand total</strong></td><td class="right money" style="font-size:var(--text-lg)">${formatINR(order.total_amount)}</td></tr>
    </table>

    ${order.notes ? html`<p class="small" style="margin-top:var(--space-4)"><strong>Notes:</strong> ${order.notes}</p>` : ''}
    <p class="invoice-note">${company.invoice_note} · Generated ${formatDateTime(new Date().toISOString())}. CGST/SGST split assumes an intra-state supply.</p>`);
}

render().catch((error) => {
  console.error(error);
  mount(root, html`<div class="banner error">${error.message}</div>`);
});
