// =============================================================================
// main.js — delivery app. Mobile-first list of the orders assigned to the
// signed-in driver. Drivers can only (a) start a delivery (packed → out for
// delivery) and (b) mark it delivered; the database enforces this.
// The list refreshes automatically every few seconds-to-minutes (config).
// =============================================================================

import { html, mount, $, on, openModal, formatINR, formatQty, formatDateTime, statusBadge, reportError, toast, withBusy } from '../../core/ui.js';
import { requireRole } from '../../core/auth.js';
import { renderShell } from '../../core/shell.js';
import { listOrders, setOrderStatus, completeDelivery, uploadPodPhoto } from '../../core/api.js';
import { buildReturns } from '../../core/fulfilment.js';
import { config, DELIVERY_SLOTS, PAYMENT_METHODS } from '../../core/config.js';

const me = await requireRole('delivery');
if (me) start();

function start() {
  renderShell({ me, subtitle: 'Delivery', links: [] });
  const view = $('#view');
  let busy = false;
  let all = [];

  /** Google Maps search link for an address (opens the Maps app on phones). */
  const mapsUrl = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  async function draw() {
    all = await listOrders();
    const active = all.filter((o) => ['packed', 'out_for_delivery'].includes(o.status));
    const done = all.filter((o) => o.status === 'delivered').slice(0, 10);

    mount(view, html`
      <div class="page-head"><div><h1>My deliveries</h1><p>${active.length} to deliver</p></div>
        <button class="btn small" id="refresh">Refresh</button></div>
      ${active.length === 0 ? html`<div class="empty"><strong>Nothing assigned right now</strong>New deliveries appear here automatically.</div>` : ''}
      ${active.map(card)}
      ${done.length ? html`<h2 style="margin:var(--space-6) 0 var(--space-3)">Recently delivered</h2>
        ${done.map((o) => html`<div class="card order-card spread"><span><strong>${o.order_number}</strong> <span class="muted small">${o.restaurant_name}</span></span>${statusBadge(o.status)}</div>`)}` : ''}`);
  }

  function card(o) {
    return html`<article class="card order-card">
      <div class="spread"><strong>${o.order_number}</strong>${statusBadge(o.status)}</div>
      <div style="margin:var(--space-3) 0"><div><strong>${o.restaurant_name}</strong></div>
        <div class="muted">${o.delivery_address || 'No address on file'}</div></div>
      <ul class="small" style="margin:0 0 var(--space-3);padding-left:1.1rem">
        ${o.order_items.map((i) => html`<li>${i.product_name} — ${formatQty(i.quantity)} ${i.unit}</li>`)}</ul>
      <div class="spread small"><span class="muted">Slot</span><span>${DELIVERY_SLOTS[o.delivery_slot]?.label ?? '—'} · ${DELIVERY_SLOTS[o.delivery_slot]?.time ?? ''}</span></div>
      <div class="spread small" style="margin-bottom:var(--space-3)"><span class="muted">${o.payment_method === 'cod' && o.payment_status !== 'paid' ? 'Collect cash' : 'Order total (no cash to collect)'}</span><span class="money">${formatINR(o.total_amount)}</span></div>
      <div class="row-wrap">
        ${o.delivery_address ? html`<a class="btn" target="_blank" rel="noopener" href="${mapsUrl(o.delivery_address)}">Open map</a>` : ''}
        ${o.contact_phone ? html`<a class="btn" href="tel:${o.contact_phone}">Call</a>` : ''}
        ${o.status === 'packed'
          ? html`<button class="btn primary grow" data-start="${o.id}">Start delivery</button>`
          : html`<button class="btn primary grow" data-done="${o.id}">Complete delivery</button>`}
      </div></article>`;
  }

  on(view, 'click', '[data-start]', async (_e, b) => {
    try { await withBusy(b, () => setOrderStatus(b.dataset.start, 'out_for_delivery', 'Picked up by driver')); toast('On the way', 'success'); await refresh(); }
    catch (error) { reportError(error); }
  });
  on(view, 'click', '[data-done]', (_e, b) => completeSheet(all.find((o) => o.id === b.dataset.done)));
  on(view, 'click', '#refresh', () => refresh());

  // The delivery sheet: a POD photo, the customer's 4-digit code, and any items
  // refused at the door. complete_delivery re-totals, takes the stock back and
  // records COD cash. The order carries an OTP only if the trip was dispatched.
  function completeSheet(order) {
    if (!order) return;
    const lines = order.order_items.map((i) => ({ ...i, ret: 0 }));
    let photoPath = null;
    const { el, close } = openModal(html`
      <form id="pod" class="stack" novalidate>
        <div><strong>${order.order_number}</strong> · ${order.restaurant_name}</div>
        <label class="field"><span class="label">Delivery code (ask the customer)</span><input class="input" name="otp" inputmode="numeric" maxlength="4" placeholder="4 digits"></label>
        <div class="field"><span class="label">Photo of the drop (optional)</span><div class="row"><div id="pod-preview" class="muted small">None yet</div><input type="file" id="pod-photo" accept="image/jpeg,image/png,image/webp" capture="environment"></div></div>
        <details><summary class="small">Something refused at the door?</summary>
          <table class="table small-table" style="margin-top:var(--space-2)"><thead><tr><th>Item</th><th class="right">Ordered</th><th class="right">Return</th></tr></thead>
          <tbody>${lines.map((l) => html`<tr><td>${l.product_name}</td><td class="right num">${formatQty(l.quantity)} ${l.unit}</td>
            <td class="right"><input class="input small num right" type="number" min="0" step="any" data-ret="${l.id}" value="0" style="width:84px"></td></tr>`)}</tbody></table>
          <p class="muted tiny">To refuse a whole order, don't complete it — call the office to cancel.</p></details>
        <label class="field"><span class="label">Note (optional)</span><input class="input" name="note" maxlength="200"></label>
        <p class="form-error" id="pod-error" role="alert"></p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Mark delivered</button></div>
      </form>`, { title: 'Complete delivery' });

    const fileInput = $('#pod-photo', el);
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try { $('#pod-preview', el).textContent = 'Uploading…'; photoPath = await uploadPodPhoto(file); $('#pod-preview', el).textContent = 'Photo attached'; }
      catch (error) { $('#pod-preview', el).textContent = 'None yet'; $('#pod-error', el).textContent = error.message; }
    };
    on(el, 'input', '[data-ret]', (_e, input) => { const l = lines.find((x) => x.id === input.dataset.ret); if (l) l.ret = input.value; });

    $('#pod', el).onsubmit = async (event) => {
      event.preventDefault();
      const picks = new Map(lines.filter((l) => Number(l.ret) > 0).map((l) => [l.id, l.ret]));
      const { lines: returns, error } = buildReturns(order.order_items, picks);
      if (error) { $('#pod-error', el).textContent = error; return; }
      try {
        const r = await withBusy($('button[type="submit"]', event.target), () => completeDelivery(order.id, { otp: event.target.elements.otp.value.trim() || null, photoPath, note: event.target.elements.note.value, returns }));
        toast(r.cash_collected > 0 ? `Delivered · collect ${formatINR(r.cash_collected)}` : 'Delivered', 'success');
        close(); await refresh();
      } catch (error2) { $('#pod-error', el).textContent = error2.message; }
    };
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try { await draw(); } catch (error) { reportError(error); } finally { busy = false; }
  }

  refresh();
  setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) refresh(); }, config.deliveryPollMs);
}
