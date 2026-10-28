// =============================================================================
// orders.js — all orders in the caller's scope: filter by status, city and
// sector; open detail; advance status; assign driver; record a receipt against a
// delivered order (payments.js receiptDialog, migration 015); export.
// The allowed transitions are enforced by the database (set_order_status);
// NEXT_STATUS below only decides which button to show, and the permission
// checks only hide buttons the database would refuse anyway.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, withBusy, formatDateTime, formatDate, statusBadge, openModal,
         confirmDialog, reportError, toast, STATUS_LABELS } from '../../core/ui.js';
import { listOrders, getOrderHistory, setOrderStatus, assignDelivery, listUsers, listCities, listSectors, setPackedQuantities,
         placeOrderFor, listRestaurants, listProducts } from '../../core/api.js';
import { receiptDialog } from './payments.js';
import { DELIVERY_SLOTS, PAYMENT_METHODS, webRoot } from '../../core/config.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';

const NEXT_STATUS = {
  placed: { to: 'confirmed', label: 'Confirm order' },
  confirmed: { to: 'packed', label: 'Mark packed' },
  packed: { to: 'out_for_delivery', label: 'Dispatch' },
  out_for_delivery: { to: 'delivered', label: 'Mark delivered' },
};

export async function renderOrders(container, me) {
  const filter = { status: '', cityId: '', sectorCode: '' };
  const [drivers, cities, sectors] = await Promise.all([
    can(me, 'team', 'view') ? listUsers().then((u) => u.filter((x) => x.role === 'delivery' && x.is_active)) : Promise.resolve([]),
    listCities(),
    listSectors(),
  ]);
  const cityName = Object.fromEntries(cities.map((c) => [c.id, c.name]));
  const sectorName = Object.fromEntries(sectors.map((s) => [s.code, s.name]));
  let orders = [];

  async function draw() {
    orders = await listOrders({ status: filter.status || undefined, cityId: filter.cityId || undefined, sectorCode: filter.sectorCode || undefined });
    mount(container, html`
      <div class="page-head"><div><h1>Orders</h1><p>${orders.length} shown</p></div>
        <div class="row">
          <a class="btn" href="#issues">Issues &amp; credits</a>
          ${can(me, 'orders', 'edit') ? html`<button class="btn" id="new-order">New order for a customer</button>` : ''}
          ${can(me, 'orders', 'export') ? html`<button class="btn" id="export">Export CSV</button>` : ''}
        </div></div>
      <div class="toolbar">
        <select class="select" data-filter="status" aria-label="Filter by status">
          <option value="">All statuses</option>
          ${Object.keys(NEXT_STATUS).concat(['delivered', 'cancelled']).map((s) =>
            html`<option value="${s}" ${s === filter.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`)}
        </select>
        ${cities.length > 1 ? html`<select class="select" data-filter="cityId" aria-label="Filter by city">
          <option value="">All cities</option>
          ${cities.map((c) => html`<option value="${c.id}" ${c.id === filter.cityId ? 'selected' : ''}>${c.name}</option>`)}
        </select>` : ''}
        <select class="select" data-filter="sectorCode" aria-label="Filter by sector">
          <option value="">All sectors</option>
          ${sectors.map((s) => html`<option value="${s.code}" ${s.code === filter.sectorCode ? 'selected' : ''}>${s.name}</option>`)}
        </select>
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Order</th><th>Customer</th><th>Deliver</th><th class="right">Total</th><th>Payment</th><th>Status</th></tr></thead>
        <tbody>${orders.length === 0
          ? html`<tr><td colspan="6"><div class="empty">No orders.</div></td></tr>`
          : orders.map((o) => html`<tr class="clickable" data-order="${o.id}">
              <td><strong>${o.order_number}</strong><div class="muted tiny nowrap">${formatDateTime(o.created_at)}</div></td>
              <td>${o.restaurant_name}<div class="muted tiny">${sectorName[o.sector_code] ?? ''}${cities.length > 1 ? ` · ${cityName[o.city_id] ?? ''}` : ''}${o.po_reference ? html` · PO ${o.po_reference}` : ''}</div></td>
              <td class="nowrap">${formatDate(o.delivery_date)}<div class="muted tiny">${DELIVERY_SLOTS[o.delivery_slot]?.label ?? ''}</div></td>
              <td class="right money">${formatINR(o.total_amount)}</td>
              <td><span class="badge ${o.payment_status === 'paid' ? 'approved' : 'pending'}">${o.payment_status === 'paid' ? 'Paid' : PAYMENT_METHODS[o.payment_method]?.label ?? 'Unpaid'}</span></td>
              <td>${statusBadge(o.status)}</td></tr>`)}
        </tbody></table></div></div>`);

    container.querySelectorAll('[data-filter]').forEach((select) => {
      select.onchange = () => { filter[select.dataset.filter] = select.value; draw().catch(reportError); };
    });
    container.querySelectorAll('[data-order]').forEach((row) => {
      row.onclick = () => showOrder(orders.find((o) => o.id === row.dataset.order), drivers, me, () => draw().catch(reportError));
    });
  }

  on(container, 'click', '#export', () => downloadCsv('orders.csv', orders, [
    { key: 'order_number', label: 'Order' },
    { key: 'created_at', label: 'Placed' },
    { key: 'restaurant_name', label: 'Customer' },
    { label: 'Sector', value: (o) => sectorName[o.sector_code] ?? o.sector_code },
    { label: 'City', value: (o) => cityName[o.city_id] ?? '' },
    { key: 'po_reference', label: 'PO ref' },
    { key: 'delivery_date', label: 'Delivery date' },
    { key: 'delivery_slot', label: 'Slot' },
    { key: 'status', label: 'Status' },
    { key: 'payment_method', label: 'Payment' },
    { key: 'payment_status', label: 'Paid?' },
    { key: 'due_date', label: 'Due date' },
    { key: 'subtotal', label: 'Subtotal' },
    { key: 'tax_amount', label: 'GST' },
    { key: 'delivery_fee', label: 'Delivery fee' },
    { key: 'total_amount', label: 'Total' },
  ]));

  on(container, 'click', '#new-order', () => newOrderDialog(() => draw().catch(reportError)));

  await draw();
}

/** Staff place an order on behalf of a customer (place_order_for; bypasses the slot cut-off). */
async function newOrderDialog(onPlaced) {
  const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span> Loading…</div>`, { title: 'New order for a customer', wide: true });
  try {
    const [restaurants, products] = await Promise.all([listRestaurants(), listProducts()]);
    const approved = restaurants.filter((r) => r.status === 'approved');
    const active = products.filter((p) => p.is_active && !p.parent_product_id);
    const lines = [{ product_id: '', quantity: '' }];
    const draw = () => {
      mount(el, html`
        <form id="po-for" class="stack" novalidate>
          <div class="form-grid">
            <label class="field"><span class="label">Customer</span><select class="select" name="restaurant" required><option value="">Choose a customer…</option>${approved.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></label>
            <label class="field"><span class="label">Payment</span><select class="select" name="payment">${Object.entries(PAYMENT_METHODS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></label>
            <label class="field"><span class="label">Deliver on</span><input class="input" name="date" type="date"></label>
            <label class="field"><span class="label">Slot</span><select class="select" name="slot">${Object.entries(DELIVERY_SLOTS).map(([k, v]) => html`<option value="${k}" ${k === 'morning' ? 'selected' : ''}>${v.label}</option>`)}</select></label>
            <label class="field span-2"><span class="label">PO / indent reference (if the sector needs one)</span><input class="input" name="po" maxlength="60"></label>
          </div>
          <table class="table small-table"><thead><tr><th>Product</th><th class="right">Quantity</th><th></th></tr></thead>
            <tbody>${lines.map((l, i) => html`<tr data-line="${i}">
              <td><select class="select small" data-field="product_id"><option value="">Choose…</option>${active.map((p) => html`<option value="${p.id}" ${p.id === l.product_id ? 'selected' : ''}>${p.name} (${p.unit})</option>`)}</select></td>
              <td class="right"><input class="input small num right" type="number" min="0" step="any" data-field="quantity" value="${l.quantity}" style="width:100px"></td>
              <td class="right"><button type="button" class="btn ghost small" data-remove="${i}" ${lines.length === 1 ? 'disabled' : ''}>✕</button></td></tr>`)}</tbody></table>
          <div><button type="button" class="btn small" id="add-line">+ Add line</button></div>
          <p class="form-error" id="po-for-error" role="alert"></p>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Place order</button></div>
        </form>`);
    };
    on(el, 'change', '[data-field]', (_e, input) => { lines[Number(input.closest('[data-line]').dataset.line)][input.dataset.field] = input.value; });
    on(el, 'click', '#add-line', () => { lines.push({ product_id: '', quantity: '' }); draw(); });
    on(el, 'click', '[data-remove]', (_e, b) => { lines.splice(Number(b.dataset.remove), 1); draw(); });
    draw();
    el.querySelector('#po-for').onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target;
      if (!form.elements.restaurant.value) { $('#po-for-error', el).textContent = 'Choose a customer.'; return; }
      const items = lines.filter((l) => l.product_id && Number(l.quantity) > 0).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) }));
      if (!items.length) { $('#po-for-error', el).textContent = 'Add at least one line.'; return; }
      try {
        const r = await withBusy($('button[type="submit"]', form), () => placeOrderFor(form.elements.restaurant.value, items, {
          deliveryDate: form.elements.date.value || null, slot: form.elements.slot.value, paymentMethod: form.elements.payment.value, poReference: form.elements.po.value,
        }));
        toast(`${r.order_number} placed (${formatINR(r.total_amount)})`, 'success'); close(); onPlaced();
      } catch (error) { $('#po-for-error', el).textContent = error.message; }
    };
  } catch (error) { close(); reportError(error); }
}

async function showOrder(order, drivers, me, refresh) {
  const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`,
    { title: order.order_number, wide: true });
  try {
    const history = await getOrderHistory(order.id);
    const next = NEXT_STATUS[order.status];
    const final = order.status === 'delivered' || order.status === 'cancelled';
    const canEdit = can(me, 'orders', 'edit');
    const canPay = can(me, 'payments', 'edit');
    // Packed quantities (actual weight / short supply) are entered while the order is confirmed or packed.
    const packable = canEdit && (order.status === 'confirmed' || order.status === 'packed');

    mount(el, html`
      <div class="spread">${statusBadge(order.status)}<span class="muted small">${formatDateTime(order.created_at)}</span></div>
      <dl class="kv" style="margin:var(--space-4) 0">
        <dt>Restaurant</dt><dd>${order.restaurant_name}</dd>
        <dt>Address</dt><dd>${order.delivery_address || '—'}</dd>
        <dt>Phone</dt><dd>${order.contact_phone || '—'}</dd>
        <dt>Delivery</dt><dd>${DELIVERY_SLOTS[order.delivery_slot]?.label ?? '—'} (${DELIVERY_SLOTS[order.delivery_slot]?.time ?? ''}), ${formatDate(order.delivery_date)}</dd>
        <dt>Payment</dt><dd>${PAYMENT_METHODS[order.payment_method]?.label ?? '—'} ·
          ${order.payment_status === 'paid' ? html`Paid ${formatDateTime(order.paid_at)}` : html`<strong>Unpaid</strong>${order.due_date ? html` · due ${formatDate(order.due_date)}` : ''}`}
          ${canPay && order.payment_status !== 'paid' ? (order.status === 'delivered'
            ? html`<button class="btn small" data-pay>Record payment</button>`
            : html`<span class="muted tiny">(receipts are recorded once delivered; see <a href="#payments">Payments</a>)</span>`) : ''}</dd>
        ${order.po_reference ? html`<dt>PO / indent</dt><dd>${order.po_reference}</dd>` : ''}
        ${order.notes ? html`<dt>Notes</dt><dd>${order.notes}</dd>` : ''}
      </dl>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Item</th><th class="right">Qty</th>${packable ? html`<th class="right">Packed</th>` : ''}<th class="right">Price</th><th class="right">Total</th></tr></thead>
        <tbody>${order.order_items.map((i) => html`<tr><td>${i.product_name}${i.hsn_code ? html` <span class="muted tiny">HSN ${i.hsn_code}</span>` : ''}</td>
          <td class="right num">${formatQty(i.quantity)} ${i.unit}${i.ordered_quantity != null && Number(i.ordered_quantity) !== Number(i.quantity) ? html`<div class="muted tiny">ordered ${formatQty(i.ordered_quantity)}</div>` : ''}</td>
          ${packable ? html`<td class="right"><input class="input small num right" type="number" min="0.01" step="any" data-packed="${i.id}" value="${i.quantity}" style="width:96px" aria-label="Packed ${i.product_name}"></td>` : ''}
          <td class="right num">${formatINR(i.unit_price)}</td><td class="right money">${formatINR(i.line_total)}</td></tr>`)}</tbody>
        <tfoot>
          <tr><td colspan="${packable ? 4 : 3}" class="right muted">Subtotal</td><td class="right num">${formatINR(order.subtotal)}</td></tr>
          <tr><td colspan="${packable ? 4 : 3}" class="right muted">GST</td><td class="right num">${formatINR(order.tax_amount)}</td></tr>
          ${Number(order.delivery_fee) > 0 ? html`<tr><td colspan="${packable ? 4 : 3}" class="right muted">Delivery fee (below minimum order)</td><td class="right num">${formatINR(order.delivery_fee)}</td></tr>` : ''}
          <tr><td colspan="${packable ? 4 : 3}" class="right"><strong>Total</strong></td><td class="right money">${formatINR(order.total_amount)}</td></tr></tfoot>
      </table></div>

      ${packable ? html`<div class="row" style="justify-content:flex-end;margin-top:var(--space-2)"><span class="muted small">Weighed items may differ within their tolerance; other items may only be short.</span><button class="btn" data-save-packed>Save packed quantities</button></div>` : ''}
      ${final || !canEdit ? '' : html`<label class="field" style="margin-top:var(--space-4)"><span class="label">Delivery driver</span>
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
        ${final || !canEdit ? '' : html`<button class="btn danger" data-cancel>Cancel order</button>
        ${next ? html`<button class="btn primary" data-next>${next.label}</button>` : ''}`}</div>`);

    async function run(action, message) {
      try { await action(); toast(message, 'success'); close(); refresh(); } catch (error) { reportError(error); }
    }
    const driverSelect = $('#driver', el);
    if (driverSelect) driverSelect.onchange = () => {
      if (!driverSelect.value) return;
      assignDelivery(order.id, driverSelect.value).then(() => { order.assigned_to = driverSelect.value; toast('Driver assigned', 'success'); }).catch(reportError);
    };
    on(el, 'click', '[data-pay]', () => receiptDialog({ restaurantId: order.restaurant_id, restaurantName: order.restaurant_name,
      prefill: { amount: order.total_amount, orderId: order.id } }, me, () => { close(); refresh(); }));
    on(el, 'click', '[data-save-packed]', (_e, b) => {
      const lines = [...el.querySelectorAll('[data-packed]')]
        .filter((input) => input.value !== '' && Number(input.value) !== Number(order.order_items.find((i) => i.id === input.dataset.packed)?.quantity))
        .map((input) => ({ order_item_id: input.dataset.packed, packed_quantity: Number(input.value) }));
      if (!lines.length) { toast('No quantity changed', 'info'); return; }
      run(() => withBusy(b, () => setPackedQuantities(order.id, lines)), 'Packed quantities saved; order re-totalled');
    });
    on(el, 'click', '[data-next]', () => run(() => setOrderStatus(order.id, next.to), `Order ${STATUS_LABELS[next.to].toLowerCase()}`));
    on(el, 'click', '[data-cancel]', async () => {
      if (await confirmDialog('Cancel this order? The restaurant will see it as cancelled.', { confirmText: 'Cancel order', danger: true }))
        run(() => setOrderStatus(order.id, 'cancelled', 'Cancelled by admin'), 'Order cancelled');
    });
  } catch (error) { close(); reportError(error); }
}
