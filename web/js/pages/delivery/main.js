// =============================================================================
// main.js — delivery app. Mobile-first list of the orders assigned to the
// signed-in driver. Drivers can only (a) start a delivery (packed → out for
// delivery) and (b) mark it delivered; the database enforces this.
//
// Photo requirements (migration 023):
//   • Pre-departure (loading) photo — taken at the warehouse before leaving.
//     If the trip has no loading photo, the driver sees a prompt to upload one
//     before they can start or complete any delivery on that trip.
//   • POD (proof-of-delivery) photo — taken at the customer's door. Required
//     when completing each delivery.
// =============================================================================

import { html, mount, $, on, openModal, formatINR, formatQty, formatDateTime, statusBadge, reportError, toast, withBusy } from '../../core/ui.js';
import { requireRole } from '../../core/auth.js';
import { renderShell } from '../../core/shell.js';
import { listOrders, setOrderStatus, completeDelivery, uploadPodPhoto, getDeliveryPins, listTrips, uploadTripPhoto, recordTripDeparture } from '../../core/api.js';
import { mapHref, whatsappHref } from '../../core/notify.js';
import { buildReturns } from '../../core/fulfilment.js';
import { config, DELIVERY_SLOTS, PAYMENT_METHODS } from '../../core/config.js';

const me = await requireRole('delivery');
if (me) start();

function start() {
  renderShell({ me, subtitle: 'Delivery', links: [] });
  const view = $('#view');
  let busy = false;
  let all = [];
  let trip = null;   // the single dispatched trip assigned to this driver (if any)

  // Map pins (migration 018): the exact spot the customer marked, when they have; else the address.
  let pins = {};
  const mapsUrl = (o) => mapHref(pins[o.id]?.lat, pins[o.id]?.lng, o.delivery_address);

  async function draw() {
    [all, pins] = await Promise.all([listOrders(), getDeliveryPins().catch(() => ({}))]);

    // Find the active dispatched trip for this driver (may be null if trips feature not in use)
    const trips = await listTrips({ status: 'dispatched', driverId: me.id }).catch(() => []);
    trip = trips[0] ?? null;

    const active = all.filter((o) => ['packed', 'out_for_delivery'].includes(o.status));
    const done = all.filter((o) => o.status === 'delivered').slice(0, 10);

    const needsLoadingPhoto = trip && !trip.pre_departure_photo_path;

    mount(view, html`
      <div class="page-head"><div><h1>My deliveries</h1><p>${active.length} to deliver</p></div>
        <button class="btn small" id="refresh">Refresh</button></div>

      ${needsLoadingPhoto ? html`
        <div class="card" style="border:2px solid var(--warning);background:var(--warning-bg,#fffbeb)">
          <strong>📷 Upload loading photo before you leave</strong>
          <p class="small muted" style="margin:var(--space-2) 0">Take a photo of all the packed items in the vehicle. This is required before starting any delivery.</p>
          <div id="loading-preview" class="small muted" style="margin-bottom:var(--space-2)">No photo yet</div>
          <label class="btn" style="cursor:pointer">
            Choose photo
            <input type="file" id="loading-photo" accept="image/jpeg,image/png,image/webp" capture="environment" style="position:absolute;opacity:0;pointer-events:none">
          </label>
        </div>` : ''}

      ${trip && trip.pre_departure_photo_path ? html`
        <div class="card" style="border:2px solid var(--success,#16a34a);background:var(--success-bg,#f0fdf4)">
          <span class="small">✅ Loading photo uploaded · ready to deliver</span>
        </div>` : ''}

      ${active.length === 0 ? html`<div class="empty"><strong>Nothing assigned right now</strong>New deliveries appear here automatically.</div>` : ''}
      ${active.map((o) => card(o, needsLoadingPhoto))}
      ${done.length ? html`<h2 style="margin:var(--space-6) 0 var(--space-3)">Recently delivered</h2>
        ${done.map((o) => html`<div class="card order-card spread"><span><strong>${o.order_number}</strong> <span class="muted small">${o.restaurant_name}</span></span>${statusBadge(o.status)}</div>`)}` : ''}`);

    // Wire up loading photo input after mount
    if (needsLoadingPhoto) {
      const photoInput = $('#loading-photo', view);
      if (photoInput) photoInput.onchange = () => handleLoadingPhoto(photoInput);
    }
  }

  async function handleLoadingPhoto(input) {
    const file = input.files[0];
    if (!file || !trip) return;
    const preview = $('#loading-preview', view);
    try {
      if (preview) preview.textContent = 'Uploading…';
      const path = await uploadTripPhoto(file);
      await recordTripDeparture(trip.id, path);
      toast('Loading photo saved — you can start deliveries', 'success');
      await refresh();
    } catch (err) {
      if (preview) preview.textContent = 'Upload failed — try again';
      reportError(err);
    }
  }

  function card(o, locked) {
    return html`<article class="card order-card">
      <div class="spread"><strong>${o.order_number}</strong>${statusBadge(o.status)}</div>
      <div style="margin:var(--space-3) 0"><div><strong>${o.restaurant_name}</strong></div>
        <div class="muted">${o.delivery_address || 'No address on file'}</div></div>
      <ul class="small" style="margin:0 0 var(--space-3);padding-left:1.1rem">
        ${o.order_items.map((i) => html`<li>${i.product_name} — ${formatQty(i.quantity)} ${i.unit}</li>`)}</ul>
      <div class="spread small"><span class="muted">Slot</span><span>${DELIVERY_SLOTS[o.delivery_slot]?.label ?? '—'} · ${DELIVERY_SLOTS[o.delivery_slot]?.time ?? ''}</span></div>
      <div class="spread small" style="margin-bottom:var(--space-3)"><span class="muted">${o.payment_method === 'cod' && o.payment_status !== 'paid' ? 'Collect cash' : 'Order total (no cash to collect)'}</span><span class="money">${formatINR(o.total_amount)}</span></div>
      <div class="row-wrap">
        ${mapsUrl(o) ? html`<a class="btn" target="_blank" rel="noopener" href="${mapsUrl(o)}">${pins[o.id] ? 'Open map pin' : 'Open map'}</a>` : ''}
        ${o.contact_phone ? html`<a class="btn" href="tel:${o.contact_phone}">Call</a>` : ''}
        ${whatsappHref(o.contact_phone) ? html`<a class="btn" target="_blank" rel="noopener" href="${whatsappHref(o.contact_phone, `Hello, your ${o.order_number} delivery is on its way.`)}">WhatsApp</a>` : ''}
        ${locked
          ? html`<button class="btn" disabled title="Upload loading photo first">🔒 Upload loading photo first</button>`
          : o.status === 'packed'
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

  // The delivery sheet: a required POD photo, the customer's 4-digit OTP, and any items
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
        <div class="field">
          <span class="label">Photo of delivered items <span class="muted">(required)</span></span>
          <div class="row" style="gap:var(--space-2);align-items:center">
            <div id="pod-preview" class="muted small">None yet</div>
            <label class="btn small" style="cursor:pointer">
              Take photo
              <input type="file" id="pod-photo" accept="image/jpeg,image/png,image/webp" capture="environment" style="position:absolute;opacity:0;pointer-events:none">
            </label>
          </div>
        </div>
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
      try {
        $('#pod-preview', el).textContent = 'Uploading…';
        photoPath = await uploadPodPhoto(file);
        $('#pod-preview', el).textContent = '✓ Photo attached';
        $('#pod-preview', el).style.color = 'var(--success,#16a34a)';
      } catch (error) {
        $('#pod-preview', el).textContent = 'Upload failed — try again';
        $('#pod-error', el).textContent = error.message;
      }
    };
    on(el, 'input', '[data-ret]', (_e, input) => { const l = lines.find((x) => x.id === input.dataset.ret); if (l) l.ret = input.value; });

    $('#pod', el).onsubmit = async (event) => {
      event.preventDefault();
      if (!photoPath) { $('#pod-error', el).textContent = 'Please take a photo of the delivered items first.'; return; }
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
