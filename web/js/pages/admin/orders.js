// =============================================================================
// orders.js — all orders: filter, open detail, advance status, assign driver.
// The allowed transitions are enforced by the database (set_order_status);
// NEXT_STATUS below only decides which button to show.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, formatDateTime, formatDate, statusBadge, openModal,
         confirmDialog, reportError, toast, STATUS_LABELS } from '../../core/ui.js';
import { listOrders, getOrderHistory, setOrderStatus, assignDelivery, listUsers, setOrderPayment } from '../../core/api.js';
import { DELIVERY_SLOTS, PAYMENT_METHODS, webRoot } from '../../core/config.js';

const NEXT_STATUS = {
  placed: { to: 'confirmed', label: 'Confirm order' },
  confirmed: { to: 'packed', label: 'Mark packed' },
  packed: { to: 'out_for_delivery', label: 'Dispatch' },
  out_for_delivery: { to: 'delivered', label: 'Mark delivered' },
};

export async function renderOrders(container) {
  let filter = '';
  const [drivers] = await Promise.all([
    listUsers().then((u) => u.filter((x) => x.role === 'delivery' && x.is_active)),
  ]);

  async function draw() {
    const orders = await listOrders({ status: filter || undefined });
    mount(container, html`
      <div class="page-head"><div><h1>Orders</h1><p>${orders.length} shown</p></div></div>
      <div class="toolbar">
        <select class="select" id="status-filter" aria-label="Filter by status">
          <option value="">All statuses</option>
          ${Object.keys(NEXT_STATUS).concat(['delivered', 'cancelled']).map((s) =>
            html`<option value="${s}" ${s === filter ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`)}
        </select>
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Order</th><th>Restaurant</th><th>Deliver</th><th class="right">Total</th><th>Payment</th><th>Status</th></tr></thead>
        <tbody>${orders.length === 0
          ? html`<tr><td colspan="6"><div class="empty">No orders.</div></td></tr>`
          : orders.map((o) => html`<tr class="clickable" data-order="${o.id}">
              <td><strong>${o.order_number}</strong><div class="muted tiny nowrap">${formatDateTime(o.created_at)}</div></td><td>${o.restaurant_name}</td>
              <td class="nowrap">${formatDate(o.delivery_date)}<div class="muted tiny">${DELIVERY_SLOTS[o.delivery_slot]?.label ?? ''}</div></td>
              <td class="right money">${formatINR(o.total_amount)}</td>
              <td><span class="badge ${o.payment_status === 'paid' ? 'approved' : 'pending'}">${o.payment_status === 'paid' ? 'Paid' : PAYMENT_METHODS[o.payment_method]?.label ?? 'Unpaid'}</span></td>
              <td>${statusBadge(o.status)}</td></tr>`)}
        </tbody></table></div></div>`);

    $('#status-filter', container).onchange = (e) => { filter = e.target.value; draw().catch(reportError); };
    container.querySelectorAll('[data-order]').forEach((row) => {
      row.onclick = () => showOrder(orders.find((o) => o.id === row.dataset.order), drivers, () => draw().catch(reportError));
    });
  }
  await draw();
}

async function showOrder(order, drivers, refresh) {
  const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`,
    { title: order.order_number, wide: true });
  try {
    const history = await getOrderHistory(order.id);
    const next = NEXT_STATUS[order.status];
    const final = order.status === 'delivered' || order.status === 'cancelled';

    mount(el, html`
      <div class="spread">${statusBadge(order.status)}<span class="muted small">${formatDateTime(order.created_at)}</span></div>
      <dl class="kv" style="margin:var(--space-4) 0">
        <dt>Restaurant</dt><dd>${order.restaurant_name}</dd>
        <dt>Address</dt><dd>${order.delivery_address || '—'}</dd>
        <dt>Phone</dt><dd>${order.contact_phone || '—'}</dd>
        <dt>Delivery</dt><dd>${DELIVERY_SLOTS[order.delivery_slot]?.label ?? '—'} (${DELIVERY_SLOTS[order.delivery_slot]?.time ?? ''}), ${formatDate(order.delivery_date)}</dd>
        <dt>Payment</dt><dd>${PAYMENT_METHODS[order.payment_method]?.label ?? '—'} ·
          ${order.payment_status === 'paid' ? html`Paid ${formatDateTime(order.paid_at)} <button class="btn ghost small" data-pay="unpaid">Mark unpaid</button>` : html`<strong>Unpaid</strong> <button class="btn small" data-pay="paid">Mark paid</button>`}</dd>
        ${order.notes ? html`<dt>Notes</dt><dd>${order.notes}</dd>` : ''}
      </dl>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th></tr></thead>
        <tbody>${order.order_items.map((i) => html`<tr><td>${i.product_name}</td>
          <td class="right num">${formatQty(i.quantity)} ${i.unit}</td>
          <td class="right num">${formatINR(i.unit_price)}</td><td class="right money">${formatINR(i.line_total)}</td></tr>`)}</tbody>
        <tfoot>
          <tr><td colspan="3" class="right muted">Subtotal</td><td class="right num">${formatINR(order.subtotal)}</td></tr>
          <tr><td colspan="3" class="right muted">GST</td><td class="right num">${formatINR(order.tax_amount)}</td></tr>
          <tr><td colspan="3" class="right"><strong>Total</strong></td><td class="right money">${formatINR(order.total_amount)}</td></tr></tfoot>
      </table></div>

      ${final ? '' : html`<label class="field" style="margin-top:var(--space-4)"><span class="label">Delivery driver</span>
        <select class="select" id="driver">
          <option value="">— Unassigned —</option>
          ${drivers.map((d) => html`<option value="${d.id}" ${d.id === order.assigned_to ? 'selected' : ''}>${d.full_name || d.email}</option>`)}
        </select>
        ${drivers.length === 0 ? html`<span class="hint">No delivery staff yet. Add them in Team.</span>` : ''}</label>`}

      <h3 style="margin:var(--space-4) 0 var(--space-3)">History</h3>
      <ul class="timeline">${history.map((h) => html`<li><strong>${STATUS_LABELS[h.to_status]}</strong>
        <span class="muted"> · ${formatDateTime(h.created_at)}</span>${h.note ? html`<div class="muted">${h.note}</div>` : ''}</li>`)}</ul>

      <div class="row" style="justify-content:flex-end;margin-top:var(--space-5)">
        <a class="btn" target="_blank" rel="noopener" href="${webRoot}invoice.html?order=${order.id}">Invoice</a>
        ${final ? '' : html`<button class="btn danger" data-cancel>Cancel order</button>
        ${next ? html`<button class="btn primary" data-next>${next.label}</button>` : ''}`}</div>`);

    async function run(action, message) {
      try { await action(); toast(message, 'success'); close(); refresh(); } catch (error) { reportError(error); }
    }
    const driverSelect = $('#driver', el);
    if (driverSelect) driverSelect.onchange = () => {
      if (!driverSelect.value) return;
      assignDelivery(order.id, driverSelect.value).then(() => { order.assigned_to = driverSelect.value; toast('Driver assigned', 'success'); }).catch(reportError);
    };
    on(el, 'click', '[data-pay]', (_e, b) => run(() => setOrderPayment(order.id, b.dataset.pay), b.dataset.pay === 'paid' ? 'Marked as paid' : 'Marked as unpaid'));
    on(el, 'click', '[data-next]', () => run(() => setOrderStatus(order.id, next.to), `Order ${STATUS_LABELS[next.to].toLowerCase()}`));
    on(el, 'click', '[data-cancel]', async () => {
      if (await confirmDialog('Cancel this order? The restaurant will see it as cancelled.', { confirmText: 'Cancel order', danger: true }))
        run(() => setOrderStatus(order.id, 'cancelled', 'Cancelled by admin'), 'Order cancelled');
    });
  } catch (error) { close(); reportError(error); }
}
