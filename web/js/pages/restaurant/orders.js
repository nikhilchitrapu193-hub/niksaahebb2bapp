// =============================================================================
// orders.js — a restaurant's order history, order detail, cancel and reorder.
// =============================================================================

import { html, mount, on, formatINR, formatQty, formatDateTime, formatDate, statusBadge, openModal,
         confirmDialog, reportError, toast, STATUS_LABELS } from '../../core/ui.js';
import { listOrders, getOrderHistory, setOrderStatus } from '../../core/api.js';
import { setQty, getQty } from './cart.js';
import { DELIVERY_SLOTS, PAYMENT_METHODS, webRoot } from '../../core/config.js';
import { isUnavailable } from './catalogue.js';

export async function renderOrders(container, state) {
  const orders = await listOrders();

  if (!orders.length) {
    mount(container, html`<div class="page-head"><h1>My orders</h1></div>
      <div class="empty"><strong>No orders yet</strong>Your orders will appear here.</div>`);
    return;
  }

  mount(container, html`
    <div class="page-head"><div><h1>My orders</h1><p>${orders.length} most recent</p></div></div>
    ${orders.map((o) => html`
      <article class="card order-card clickable" data-order="${o.id}" tabindex="0" style="cursor:pointer">
        <div class="spread">
          <div><strong>${o.order_number}</strong> <span class="muted small">· ${formatDateTime(o.created_at)}</span></div>
          ${statusBadge(o.status)}
        </div>
        <div class="spread small" style="margin-top:var(--space-2)">
          <span class="muted">${o.order_items.length} item${o.order_items.length === 1 ? '' : 's'} · ${DELIVERY_SLOTS[o.delivery_slot]?.label ?? ''} ${formatDate(o.delivery_date)} · ${PAYMENT_METHODS[o.payment_method]?.label ?? ''}${o.payment_status === 'paid' ? ' · Paid' : ''}</span>
          <span class="money">${formatINR(o.total_amount)}</span>
        </div>
      </article>`)}`);

  on(container, 'click', '[data-order]', (_e, el) => {
    const order = orders.find((o) => o.id === el.dataset.order);
    showOrder(order, state, () => renderOrders(container, state));
  });
}

async function showOrder(order, state, refresh) {
  const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`,
    { title: order.order_number, wide: true });
  try {
    const history = await getOrderHistory(order.id);
    mount(el, html`
      <div class="spread"><span class="muted small">${formatDateTime(order.created_at)}</span>${statusBadge(order.status)}</div>
      <div class="table-wrap" style="margin:var(--space-4) 0"><table class="table">
        <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th></tr></thead>
        <tbody>${order.order_items.map((i) => html`<tr>
          <td>${i.product_name}</td><td class="right num">${formatQty(i.quantity)} ${i.unit}</td>
          <td class="right num">${formatINR(i.unit_price)}</td><td class="right money">${formatINR(i.line_total)}</td></tr>`)}</tbody>
        <tfoot>
          <tr><td colspan="3" class="right muted">Subtotal</td><td class="right num">${formatINR(order.subtotal)}</td></tr>
          <tr><td colspan="3" class="right muted">GST</td><td class="right num">${formatINR(order.tax_amount)}</td></tr>
          <tr><td colspan="3" class="right"><strong>Total</strong></td><td class="right money">${formatINR(order.total_amount)}</td></tr></tfoot>
      </table></div>
      <dl class="kv">
        <dt>Delivery</dt><dd>${DELIVERY_SLOTS[order.delivery_slot]?.label ?? '—'}, ${formatDate(order.delivery_date)}</dd>
        <dt>Payment</dt><dd>${PAYMENT_METHODS[order.payment_method]?.label ?? '—'} · ${order.payment_status === 'paid' ? 'Paid' : 'Unpaid'}</dd>
        ${order.notes ? html`<dt>Notes</dt><dd>${order.notes}</dd>` : ''}
      </dl>
      <h3 style="margin:var(--space-4) 0 var(--space-3)">Progress</h3>
      <ul class="timeline">${history.map((h) => html`<li><strong>${STATUS_LABELS[h.to_status]}</strong>
        <span class="muted"> · ${formatDateTime(h.created_at)}</span>${h.note ? html`<div class="muted">${h.note}</div>` : ''}</li>`)}</ul>
      <div class="row" style="justify-content:flex-end;margin-top:var(--space-5)">
        ${order.status === 'placed' ? html`<button class="btn danger" data-cancel>Cancel order</button>` : ''}
        <a class="btn" target="_blank" rel="noopener" href="${webRoot}invoice.html?order=${order.id}">Invoice</a>
        <button class="btn primary" data-reorder>Order again</button>
      </div>`);
  } catch (error) { close(); reportError(error); return; }

  on(el, 'click', '[data-cancel]', async () => {
    if (!(await confirmDialog('Cancel this order?', { confirmText: 'Cancel order', danger: true }))) return;
    try {
      await setOrderStatus(order.id, 'cancelled', 'Cancelled by restaurant');
      toast('Order cancelled', 'success');
      close(); refresh();
    } catch (error) { reportError(error); }
  });
  on(el, 'click', '[data-reorder]', () => {
    let added = 0;
    for (const item of order.order_items) {
      const product = state.byId[item.product_id];
      if (product && !isUnavailable(product)) { setQty(product.id, getQty(product.id) + Number(item.quantity)); added += 1; }
    }
    close();
    toast(added ? `${added} item${added === 1 ? '' : 's'} added to your cart` : 'None of these items are available right now', added ? 'success' : 'error');
  });
}
