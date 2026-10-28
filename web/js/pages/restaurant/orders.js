// =============================================================================
// orders.js — a restaurant's order history, order detail, cancel and reorder.
// A placed order can be edited or cancelled by the customer only within their
// sector's edit window (my_order_terms.customer_edit_window_minutes, migration
// 017). After that the slot stays open to staff; the customer sees how many
// minutes are left, then "Call us to make changes." The database re-checks.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, formatDateTime, formatDate, statusBadge, openModal,
         confirmDialog, reportError, toast, STATUS_LABELS } from '../../core/ui.js';
import { listOrders, getOrderHistory, cancelOrder, editOrder, reportIssue } from '../../core/api.js';
import { setQty, getQty } from './cart.js';
import { DELIVERY_SLOTS, PAYMENT_METHODS, ISSUE_KINDS, webRoot } from '../../core/config.js';

/** True while the customer may still change / cancel their own placed order (migration 017). */
export function canCustomerChange(order, terms) {
  if (order.status !== 'placed') return false;
  const windowMin = Number(terms?.customer_edit_window_minutes ?? 15);
  if (windowMin <= 0) return false;
  return Date.now() - new Date(order.created_at).getTime() < windowMin * 60_000;
}
/** Whole minutes left in that window (0 once spent). */
export function minutesLeftToChange(order, terms) {
  const windowMin = Number(terms?.customer_edit_window_minutes ?? 15);
  const left = Math.ceil((windowMin * 60_000 - (Date.now() - new Date(order.created_at).getTime())) / 60_000);
  return left > 0 ? left : 0;
}
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

/** The one-line notice above the buttons: time left, "call us" when spent, or "no self-edit" when the sector is 0. */
function windowNotice(order, terms) {
  const windowMin = Number(terms?.customer_edit_window_minutes ?? 15);
  if (windowMin <= 0) {
    return html`<p class="muted small" style="text-align:right">Changes and cancellations go through our team — please call us.</p>`;
  }
  const left = minutesLeftToChange(order, terms);
  if (left === 0) {
    return html`<p class="muted small" style="text-align:right">Your ${windowMin}-minute window to change this order has passed. Call us to make changes.</p>`;
  }
  return html`<p class="muted small" style="text-align:right">You can still edit or cancel this order for about ${left} more minute${left === 1 ? '' : 's'}.</p>`;
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
          <td>${i.product_name}</td><td class="right num">${formatQty(i.quantity)} ${i.unit}${i.ordered_quantity != null && Number(i.ordered_quantity) !== Number(i.quantity) ? html`<div class="muted tiny">ordered ${formatQty(i.ordered_quantity)}, billed on packed weight</div>` : ''}</td>
          <td class="right num">${formatINR(i.unit_price)}</td><td class="right money">${formatINR(i.line_total)}</td></tr>`)}</tbody>
        <tfoot>
          <tr><td colspan="3" class="right muted">Subtotal</td><td class="right num">${formatINR(order.subtotal)}</td></tr>
          <tr><td colspan="3" class="right muted">GST</td><td class="right num">${formatINR(order.tax_amount)}</td></tr>
          <tr><td colspan="3" class="right"><strong>Total</strong></td><td class="right money">${formatINR(order.total_amount)}</td></tr></tfoot>
      </table></div>
      <dl class="kv">
        <dt>Delivery</dt><dd>${DELIVERY_SLOTS[order.delivery_slot]?.label ?? '—'}, ${formatDate(order.delivery_date)}</dd>
        <dt>Payment</dt><dd>${PAYMENT_METHODS[order.payment_method]?.label ?? '—'} · ${order.payment_status === 'paid' ? 'Paid' : html`Unpaid${order.due_date ? html` · due ${formatDate(order.due_date)}` : ''}${order.status === 'delivered' ? html` · <a href="#payments">Payments</a>` : ''}`}</dd>
        ${order.notes ? html`<dt>Notes</dt><dd>${order.notes}</dd>` : ''}
      </dl>
      <h3 style="margin:var(--space-4) 0 var(--space-3)">Progress</h3>
      <ul class="timeline">${history.map((h) => html`<li><strong>${STATUS_LABELS[h.to_status]}</strong>
        <span class="muted"> · ${formatDateTime(h.created_at)}</span>${h.note ? html`<div class="muted">${h.note}</div>` : ''}</li>`)}</ul>
      ${order.status === 'placed' ? windowNotice(order, state.terms) : ''}
      <div class="row" style="justify-content:flex-end;margin-top:var(--space-2);flex-wrap:wrap">
        ${canCustomerChange(order, state.terms) ? html`<button class="btn" data-edit>Edit order</button>` : ''}
        ${canCustomerChange(order, state.terms) ? html`<button class="btn danger" data-cancel>Cancel order</button>` : ''}
        ${order.status === 'delivered' ? html`<button class="btn" data-issue>Report an issue</button>` : ''}
        <a class="btn" target="_blank" rel="noopener" href="${webRoot}invoice.html?order=${order.id}">Invoice</a>
        <button class="btn primary" data-reorder>Order again</button>
      </div>`);
  } catch (error) { close(); reportError(error); return; }

  on(el, 'click', '[data-cancel]', async () => {
    if (!(await confirmDialog('Cancel this order?', { confirmText: 'Cancel order', danger: true }))) return;
    try {
      await cancelOrder(order.id, 'Cancelled by customer');
      toast('Order cancelled', 'success');
      close(); refresh();
    } catch (error) { reportError(error); }
  });
  on(el, 'click', '[data-edit]', () => editDialog(order, close, refresh));
  on(el, 'click', '[data-issue]', () => issueDialog(order, close, refresh));
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

/** Edit a still-placed order: adjust quantities or drop a line (before the cut-off). */
function editDialog(order, closeParent, refresh) {
  const lines = order.order_items.map((i) => ({ product_id: i.product_id, name: i.product_name, unit: i.unit, quantity: Number(i.ordered_quantity ?? i.quantity) }));
  const { el, close } = openModal(html`
    <form id="edit" class="stack" novalidate>
      <p class="muted small">Change quantities or remove a line. To add new products, use “Order again”.</p>
      <table class="table small-table"><thead><tr><th>Item</th><th class="right">Quantity</th><th></th></tr></thead>
        <tbody>${lines.map((l, n) => html`<tr data-row="${n}"><td>${l.name}<div class="muted tiny">${l.unit}</div></td>
          <td class="right"><input class="input small num right" type="number" min="0" step="any" data-qty="${n}" value="${l.quantity}" style="width:90px"></td>
          <td class="right"><button type="button" class="btn ghost small" data-remove="${n}">✕</button></td></tr>`)}</tbody></table>
      <p class="form-error" id="edit-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save changes</button></div>
    </form>`, { title: `Edit ${order.order_number}` });
  on(el, 'input', '[data-qty]', (_e, input) => { lines[Number(input.dataset.qty)].quantity = input.value; });
  on(el, 'click', '[data-remove]', (_e, b) => { lines[Number(b.dataset.remove)].quantity = 0; el.querySelector(`[data-qty="${b.dataset.remove}"]`).value = '0'; });
  $('#edit', el).onsubmit = async (event) => {
    event.preventDefault();
    const items = lines.filter((l) => Number(l.quantity) > 0).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) }));
    if (!items.length) { $('#edit-error', el).textContent = 'Keep at least one line (or cancel the order instead).'; return; }
    try {
      await editOrder(order.id, items);
      toast('Order updated', 'success'); close(); closeParent(); refresh();
    } catch (error) { $('#edit-error', el).textContent = error.message; }
  };
}

/** Report a problem with a delivered order. Support may raise a credit note. */
function issueDialog(order, closeParent, refresh) {
  const { el, close } = openModal(html`
    <form id="issue" class="stack" novalidate>
      <label class="field"><span class="label">What went wrong?</span><select class="select" name="kind">${Object.entries(ISSUE_KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
      <label class="field"><span class="label">Tell us more</span><textarea class="input" name="note" rows="3" maxlength="1000" placeholder="What happened?"></textarea></label>
      <p class="form-error" id="issue-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Send report</button></div>
    </form>`, { title: `Report an issue · ${order.order_number}` });
  $('#issue', el).onsubmit = async (event) => {
    event.preventDefault();
    try {
      await reportIssue(order.id, event.target.elements.kind.value, event.target.elements.note.value);
      toast('Thanks — we’ll look into it', 'success'); close(); closeParent(); refresh();
    } catch (error) { $('#issue-error', el).textContent = error.message; }
  };
}
