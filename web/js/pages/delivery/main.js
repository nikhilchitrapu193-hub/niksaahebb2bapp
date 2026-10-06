// =============================================================================
// main.js — delivery app. Mobile-first list of the orders assigned to the
// signed-in driver. Drivers can only (a) start a delivery (packed → out for
// delivery) and (b) mark it delivered; the database enforces this.
// The list refreshes automatically every few seconds-to-minutes (config).
// =============================================================================

import { html, mount, $, on, formatINR, formatQty, formatDateTime, statusBadge, reportError, toast, confirmDialog, withBusy } from '../../core/ui.js';
import { requireRole } from '../../core/auth.js';
import { renderShell } from '../../core/shell.js';
import { listOrders, setOrderStatus } from '../../core/api.js';
import { config, DELIVERY_SLOTS, PAYMENT_METHODS } from '../../core/config.js';

const me = await requireRole('delivery');
if (me) start();

function start() {
  renderShell({ me, subtitle: 'Delivery', links: [] });
  const view = $('#view');
  let busy = false;

  /** Google Maps search link for an address (opens the Maps app on phones). */
  const mapsUrl = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  async function draw() {
    const all = await listOrders();
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
          : html`<button class="btn primary grow" data-done="${o.id}">Mark delivered</button>`}
      </div></article>`;
  }

  async function act(button, status, note) {
    try { await withBusy(button, () => setOrderStatus(button.dataset.start || button.dataset.done, status, note)); toast('Updated', 'success'); await refresh(); }
    catch (error) { reportError(error); }
  }
  on(view, 'click', '[data-start]', (_e, b) => act(b, 'out_for_delivery', 'Picked up by driver'));
  on(view, 'click', '[data-done]', async (_e, b) => {
    if (await confirmDialog('Confirm this order was delivered?', { confirmText: 'Delivered' })) act(b, 'delivered', 'Delivered');
  });
  on(view, 'click', '#refresh', () => refresh());

  async function refresh() {
    if (busy) return;
    busy = true;
    try { await draw(); } catch (error) { reportError(error); } finally { busy = false; }
  }

  refresh();
  setInterval(() => { if (!document.hidden && !document.querySelector('.overlay')) refresh(); }, config.deliveryPollMs);
}
