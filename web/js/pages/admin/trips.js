// =============================================================================
// trips.js — Fulfilment → Trips: build a trip sheet (a driver + vehicle and a
// set of confirmed/packed orders), dispatch it (every packed order goes out for
// delivery with a POD OTP), and close it once delivered. Staff can also complete
// a delivery here (photo + OTP + doorstep returns) when the driver cannot.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, formatDate, formatDateTime, statusBadge, openModal, confirmDialog, reportError, toast, withBusy } from '../../core/ui.js';
import { listTrips, getTrip, createTrip, dispatchTrip, setTripStatus, listOrders, listDrivers, listVehicles, tripPhotoUrl } from '../../core/api.js';
import { tripStops, tripCodToCollect, tripOpenStops } from '../../core/fulfilment.js';
import { can } from '../../core/permissions.js';
import { TRIP_STATUSES, DELIVERY_SLOTS } from '../../core/config.js';
import { fulfilmentTabs } from './fulfilment.js';
import { tomorrowIso } from './buying-list.js';

export async function renderTrips(container, me) {
  const canEdit = can(me, 'fulfilment', 'edit');
  let status = '';
  let [trips, drivers, vehicles] = await Promise.all([listTrips(), listDrivers(), listVehicles()]);

  async function reload() { trips = await listTrips({ status: status || undefined }); draw(); }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Trips</h1><p>${trips.length} shown · ${trips.filter((t) => t.status === 'dispatched').length} out for delivery</p></div>
        ${canEdit ? html`<button class="btn primary" id="new">New trip</button>` : ''}</div>
      ${fulfilmentTabs('#trips')}
      <div class="toolbar"><select class="select" id="status"><option value="">All statuses</option>
        ${Object.entries(TRIP_STATUSES).map(([k, v]) => html`<option value="${k}" ${k === status ? 'selected' : ''}>${v.label}</option>`)}</select></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Trip</th><th>Date</th><th>Driver</th><th>Vehicle</th><th class="right">Stops</th><th class="right">COD</th><th>Status</th><th></th></tr></thead>
        <tbody>${trips.length === 0 ? html`<tr><td colspan="8"><div class="empty">No trips yet. Build one from confirmed or packed orders.</div></td></tr>` : trips.map((t) => html`
          <tr class="clickable" data-open="${t.id}">
            <td><strong>${t.trip_number}</strong><div class="muted tiny">${formatDateTime(t.created_at)}</div></td>
            <td>${formatDate(t.trip_date)}<div class="muted tiny">${DELIVERY_SLOTS[t.slot]?.label ?? ''}</div></td>
            <td>${t.driver?.full_name ?? '—'}</td><td>${t.vehicles?.registration ?? '—'}</td>
            <td class="right num">${tripOpenStops(t)} / ${tripStops(t).length}</td>
            <td class="right num">${formatINR(tripCodToCollect(t))}</td>
            <td><span class="badge ${TRIP_STATUSES[t.status]?.badge ?? ''}">${TRIP_STATUSES[t.status]?.label ?? t.status}</span></td>
            <td class="right"><button class="btn small">Open</button></td></tr>`)}</tbody></table></div></div>`);
  }

  on(container, 'change', '#status', async (_e, el) => { status = el.value; try { await reload(); } catch (error) { reportError(error); } });
  on(container, 'click', '#new', () => buildDialog());
  on(container, 'click', '[data-open]', (_e, el) => detail(el.dataset.open));

  async function detail(id) {
    const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span> Loading…</div>`, { title: 'Trip', wide: true });
    try {
      const trip = await getTrip(id);
      if (!trip) throw new Error('Trip not found');
      const stops = tripStops(trip);
      const open = trip.status === 'draft';
      const loadingPhotoUrl = trip.pre_departure_photo_path
        ? await tripPhotoUrl(trip.pre_departure_photo_path)
        : null;
      const dispatched = trip.status === 'dispatched';
      mount(el, html`
        <div class="spread"><div><strong>${trip.trip_number}</strong> <span class="badge ${TRIP_STATUSES[trip.status]?.badge ?? ''}">${TRIP_STATUSES[trip.status]?.label ?? trip.status}</span></div>
          <span class="muted small">${formatDate(trip.trip_date)} · ${DELIVERY_SLOTS[trip.slot]?.label ?? ''}</span></div>
        <dl class="kv compact" style="margin:var(--space-3) 0">
          <dt>Driver</dt><dd>${trip.driver?.full_name ?? '—'}</dd>
          <dt>Vehicle</dt><dd>${trip.vehicles?.registration ?? '—'}${trip.vehicles?.label ? ` · ${trip.vehicles.label}` : ''}</dd>
          <dt>Cash to collect</dt><dd>${formatINR(tripCodToCollect(trip))}</dd>
          ${trip.notes ? html`<dt>Notes</dt><dd>${trip.notes}</dd>` : ''}
        </dl>

        ${dispatched && !loadingPhotoUrl ? html`
          <div class="banner" style="background:var(--warning-bg,#fffbeb);border:1px solid var(--warning);border-radius:6px;padding:var(--space-3);margin-bottom:var(--space-3)">
            ⚠️ <strong>Loading photo not yet uploaded</strong> — driver must photograph the packed vehicle before starting deliveries.
          </div>` : ''}

        ${loadingPhotoUrl ? html`
          <div style="margin-bottom:var(--space-4)">
            <p class="label" style="margin-bottom:var(--space-2)">Loading photo (taken at warehouse)</p>
            <a href="${loadingPhotoUrl}" target="_blank" rel="noopener">
              <img src="${loadingPhotoUrl}" alt="Loading photo" style="max-width:100%;max-height:260px;border-radius:6px;border:1px solid var(--border)">
            </a>
            <p class="muted tiny" style="margin-top:var(--space-1)">Uploaded ${formatDateTime(trip.pre_departure_at)} · click to open full size</p>
          </div>` : ''}

        <div class="table-wrap"><table class="table small-table">
          <thead><tr><th>#</th><th>Order</th><th>Customer</th><th class="right">Total</th><th>Status</th></tr></thead>
          <tbody>${stops.map((o, i) => html`<tr><td class="muted">${i + 1}</td>
            <td><strong>${o.order_number}</strong></td><td>${o.restaurant_name}<div class="muted tiny">${o.delivery_address ?? ''}</div></td>
            <td class="right num">${formatINR(o.total_amount)}${o.payment_method === 'cod' && o.payment_status !== 'paid' ? html`<div class="muted tiny">COD</div>` : ''}</td>
            <td>${statusBadge(o.status)}</td></tr>`)}</tbody></table></div>
        <div class="row" style="justify-content:flex-end;margin-top:var(--space-4);flex-wrap:wrap">
          ${open && canEdit ? html`<button class="btn primary" data-dispatch>Dispatch</button>` : ''}
          ${open && canEdit ? html`<button class="btn danger" data-cancel>Cancel trip</button>` : ''}
          ${dispatched && canEdit ? html`<button class="btn" data-collect>Close trip</button>` : ''}
        </div>`);
      on(el, 'click', '[data-dispatch]', async (_e, b) => {
        if (!(await confirmDialog('Dispatch this trip? Every packed order goes out for delivery with a delivery code.', { confirmText: 'Dispatch' }))) return;
        try { const r = await withBusy(b, () => dispatchTrip(trip.id)); toast(`${r.dispatched} order${r.dispatched === 1 ? '' : 's'} out for delivery`, 'success'); close(); await reload(); }
        catch (error) { reportError(error); }
      });
      on(el, 'click', '[data-cancel]', async (_e, b) => {
        if (!(await confirmDialog('Cancel this draft trip?', { confirmText: 'Cancel trip', danger: true }))) return;
        try { await withBusy(b, () => setTripStatus(trip.id, 'cancelled')); toast('Trip cancelled', 'success'); close(); await reload(); } catch (error) { reportError(error); }
      });
      on(el, 'click', '[data-collect]', async (_e, b) => {
        if (!(await confirmDialog('Close this trip? Do this once every order is delivered.', { confirmText: 'Close trip' }))) return;
        try { await withBusy(b, () => setTripStatus(trip.id, 'closed')); toast('Trip closed', 'success'); close(); await reload(); } catch (error) { reportError(error); }
      });
    } catch (error) { close(); reportError(error); }
  }

  /** Build a trip from the day's confirmed / packed orders not already on one. */
  async function buildDialog() {
    let date = tomorrowIso();
    let slot = '';
    const chosen = new Set();
    const onTrip = new Set((await listTrips({})).flatMap((t) => tripStops(t).map((o) => o.id)));
    let eligible = [];

    const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span> Loading…</div>`, { title: 'New trip', wide: true });
    async function loadEligible() {
      const all = await listOrders();
      eligible = all.filter((o) => ['confirmed', 'packed'].includes(o.status) && o.delivery_date === date && (!slot || o.delivery_slot === slot) && !onTrip.has(o.id));
      drawForm();
    }
    function drawForm() {
      mount(el, html`
        <form id="trip-form" class="stack" novalidate>
          <div class="form-grid">
            <label class="field"><span class="label">Delivery date</span><input class="input" name="date" type="date" value="${date}"></label>
            <label class="field"><span class="label">Slot</span><select class="select" name="slot"><option value="">Any</option>${Object.entries(DELIVERY_SLOTS).map(([k, v]) => html`<option value="${k}" ${k === slot ? 'selected' : ''}>${v.label}</option>`)}</select></label>
            <label class="field"><span class="label">Driver</span><select class="select" name="driver" required><option value="">Choose a driver…</option>${drivers.map((d) => html`<option value="${d.id}">${d.full_name || d.email}</option>`)}</select></label>
            <label class="field"><span class="label">Vehicle</span><select class="select" name="vehicle"><option value="">—</option>${vehicles.filter((v) => v.is_active).map((v) => html`<option value="${v.id}">${v.registration}${v.label ? ` · ${v.label}` : ''}</option>`)}</select></label>
          </div>
          <div class="card"><div class="table-wrap"><table class="table">
            <thead><tr><th></th><th>Order</th><th>Customer</th><th>Slot</th><th class="right">Total</th><th>Status</th></tr></thead>
            <tbody>${eligible.length === 0 ? html`<tr><td colspan="6"><div class="empty">No eligible orders for that day. Confirm orders first.</div></td></tr>` : eligible.map((o) => html`
              <tr><td><input type="checkbox" data-pick="${o.id}" ${chosen.has(o.id) ? 'checked' : ''}></td>
                <td><strong>${o.order_number}</strong></td><td>${o.restaurant_name}</td>
                <td>${DELIVERY_SLOTS[o.delivery_slot]?.label ?? ''}</td><td class="right num">${formatINR(o.total_amount)}</td><td>${statusBadge(o.status)}</td></tr>`)}</tbody></table></div></div>
          <p class="form-error" id="trip-error" role="alert"></p>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit" ${chosen.size ? '' : 'disabled'}>Create trip${chosen.size ? ` (${chosen.size})` : ''}</button></div>
        </form>`);
      $('[name=date]', el).onchange = (e) => { date = e.target.value || tomorrowIso(); chosen.clear(); loadEligible(); };
      $('[name=slot]', el).onchange = (e) => { slot = e.target.value; chosen.clear(); loadEligible(); };
      $('#trip-form', el).onsubmit = async (event) => {
        event.preventDefault();
        const form = event.target;
        if (!form.elements.driver.value) { $('#trip-error', el).textContent = 'Choose a driver.'; return; }
        try {
          const r = await withBusy($('button[type="submit"]', form), () => createTrip({
            driverId: form.elements.driver.value, vehicleId: form.elements.vehicle.value || null, tripDate: date, slot: slot || null,
            orderIds: [...chosen], notes: null,
          }));
          toast(`${r.trip_number} created`, 'success');
          close(); await reload();
        } catch (error) { $('#trip-error', el).textContent = error.message; }
      };
    }
    on(el, 'change', '[data-pick]', (_e, cb) => { if (cb.checked) chosen.add(cb.dataset.pick); else chosen.delete(cb.dataset.pick); drawForm(); });
    await loadEligible();
  }

  draw();
}
