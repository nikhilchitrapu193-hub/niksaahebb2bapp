// =============================================================================
// fleetbase-trips.js — Fulfilment → Fleetbase trips admin screen.
//
// Shows live Fleetbase-synced trips. Admins can dispatch an order to Fleetbase
// (creates a trip) or view the current trip status. The webhook at
// supabase/functions/fleetbase-webhook keeps status in sync automatically.
// =============================================================================

import { html, mount, on, toast, badge } from '../../core/ui.js';
import { listTrips, dispatchTrip, cancelTrip, listOrders } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { TRIP_STATUSES } from '../../core/config.js';
import { config } from '../../core/config.js';

/** Render the Fleetbase trips screen. Route: #trips-fleet */
export async function renderFleetbaseTrips(container, me) {
  // If Fleetbase is not configured, show a friendly message
  if (!config.fleetbaseUrl) {
    mount(container, html`
      <div class="page-header"><h2>Fleetbase trips</h2></div>
      <div class="empty">
        <strong>Fleetbase not configured</strong>
        Set <code>config.fleetbaseUrl</code> and <code>config.fleetbaseKey</code> in
        <code>web/js/core/config.js</code> and deploy the <code>fleetbase-dispatch</code>
        Edge Function to activate live trip tracking.
      </div>
    `);
    return;
  }

  mount(container, html`
    <div class="page-header">
      <h2>Fleetbase trips</h2>
      ${can(me, 'fulfilment', 'edit') ? html`<button class="btn btn-primary" id="dispatch-btn">Dispatch order</button>` : ''}
    </div>
    <div class="filters row gap-sm mb-md">
      <select id="status-filter">
        <option value="">All statuses</option>
        ${Object.entries(TRIP_STATUSES).map(([k, v]) => `<option value="${k}">${v.label}</option>`)}
      </select>
      <input type="date" id="date-filter" value="${new Date().toISOString().slice(0, 10)}">
    </div>
    <div id="trips-list"><div class="loading">Loading…</div></div>
  `);

  on(container, '#status-filter', 'change', reload);
  on(container, '#date-filter', 'change', reload);
  on(container, '#dispatch-btn', 'click', () => openDispatchModal(me, reload));

  await reload();

  async function reload() {
    const status = container.querySelector('#status-filter')?.value || undefined;
    const date = container.querySelector('#date-filter')?.value || undefined;
    const trips = await listTrips({ status, date }).catch(e => { toast(e.message, 'error'); return []; });
    const el = container.querySelector('#trips-list');

    if (!trips.length) { mount(el, html`<p class="muted">No trips found.</p>`); return; }

    mount(el, html`
      <table class="data-table">
        <thead><tr>
          <th>Trip ID</th><th>Order</th><th>Driver</th>
          <th>Status</th><th>Dispatched</th><th></th>
        </tr></thead>
        <tbody>${trips.map(t => {
          const st = TRIP_STATUSES[t.status] ?? { label: t.status, badge: 'pending' };
          return html`
            <tr>
              <td class="mono">${t.fleetbase_trip_id?.slice(0, 8) ?? '—'}…</td>
              <td>${t.orders?.order_number ?? '—'}</td>
              <td>${t.profiles?.full_name ?? '—'}</td>
              <td>${badge(st.label, st.badge)}</td>
              <td>${t.created_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
              <td class="actions">
                ${can(me, 'fulfilment', 'edit') && !['completed', 'cancelled'].includes(t.status) ? html`
                  <button class="btn btn-sm btn-danger" data-cancel="${t.id}">Cancel</button>
                ` : ''}
              </td>
            </tr>
          `;
        }).join('')}</tbody>
      </table>
    `);

    on(el, '[data-cancel]', 'click', async e => {
      const id = e.target.dataset.cancel;
      const reason = prompt('Reason for cancellation?');
      if (reason === null) return;
      try { await cancelTrip(id, reason); toast('Trip cancelled'); reload(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }
}

async function openDispatchModal(me, onDone) {
  // Load packed orders that don't have a trip yet
  const orders = await listOrders({ status: 'packed' }).catch(() => []);

  if (!orders.length) {
    toast('No packed orders to dispatch', 'info');
    return;
  }

  // Simple select: pick an order and dispatch
  const sel = document.createElement('div');
  sel.innerHTML = `
    <h3>Dispatch to Fleetbase</h3>
    <p class="muted">Select a packed order to create a Fleetbase trip.</p>
    <select id="order-select" style="width:100%;margin-bottom:1rem">
      <option value="">— select order —</option>
      ${orders.map(o => `<option value="${o.id}">#${o.order_number} — ${o.outlets?.name ?? 'Outlet'}</option>`)}
    </select>
    <button class="btn btn-primary" id="confirm-dispatch-btn">Dispatch</button>
  `;
  document.body.appendChild(sel);
  sel.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  const inner = document.createElement('div');
  inner.style.cssText = 'background:#fff;border-radius:8px;padding:2rem;max-width:480px;width:100%';
  inner.innerHTML = sel.innerHTML;
  sel.innerHTML = '';
  sel.appendChild(inner);

  inner.querySelector('#confirm-dispatch-btn')?.addEventListener('click', async () => {
    const orderId = inner.querySelector('#order-select').value;
    if (!orderId) { alert('Select an order first.'); return; }
    try {
      await dispatchTrip(orderId);
      toast('Trip dispatched to Fleetbase');
      sel.remove();
      onDone();
    } catch (err) { toast(err.message, 'error'); }
  });

  sel.addEventListener('click', e => { if (e.target === sel) sel.remove(); });
}
