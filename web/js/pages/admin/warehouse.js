// =============================================================================
// warehouse.js — Admin: Warehouse+ storage locations & expiry alerts (P2-5)
// Route: #warehouse-plus (or surfaced from #inventory tab)
// =============================================================================

import { html, mount, on, toast, modal, reportError, withBusy, formatINR } from '../../core/ui.js';
import { getSupabase } from '../../core/api.js';
import { can } from '../../core/permissions.js';

export async function renderWarehouse(container, me) {
  const canEdit = can(me, 'inventory', 'edit');
  mount(container, html`
    <div class="page-head">
      <div><h1>Warehouse+</h1><p>Storage locations, lot tracking, and expiry alerts.</p></div>
    </div>
    <div class="tabs" id="wh-tabs">
      <button class="tab active" data-tab="expiry">Expiry alerts</button>
      <button class="tab" data-tab="lots">Inventory lots</button>
      <button class="tab" data-tab="locations">Storage locations</button>
      <button class="tab" data-tab="movements">Movements log</button>
    </div>
    <div id="tab-expiry"></div>
    <div id="tab-lots"      hidden></div>
    <div id="tab-locations" hidden></div>
    <div id="tab-movements" hidden></div>
  `);

  on(container, 'click', '.tab', (_, btn) => {
    container.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    ['expiry','lots','locations','movements'].forEach((t) => {
      container.querySelector(`#tab-${t}`).hidden = (t !== tab);
    });
    if (tab === 'expiry')     loadExpiry();
    if (tab === 'lots')       loadLots();
    if (tab === 'locations')  loadLocations(canEdit);
    if (tab === 'movements')  loadMovements();
  });

  loadExpiry();

  // ── Expiry alerts ──────────────────────────────────────────────────────────
  async function loadExpiry() {
    const el = container.querySelector('#tab-expiry');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const sb = getSupabase();
      const { data, error } = await sb.from('expiring_lots').select('*').limit(100);
      if (error) throw error;
      if (!data?.length) { mount(el, html`<div class="empty"><strong>No expiry alerts</strong>All lots expire more than 7 days out.</div>`); return; }
      mount(el, html`
        <div class="banner warn" style="margin-bottom:var(--space-3)">
          ${data.length} lot(s) expiring within 7 days or already expired. Dispose or return to supplier.
        </div>
        <table class="data-table">
          <thead><tr><th>Product</th><th>Location</th><th>Lot</th><th>Qty on hand</th><th>Expiry</th><th>Status</th></tr></thead>
          <tbody>${data.map((lot) => {
            const expired = new Date(lot.expiry_date) < new Date();
            return html`<tr class="${expired ? 'row-warn' : ''}">
              <td>${lot.product_name}</td>
              <td>${lot.location_code ?? '—'}</td>
              <td class="mono">${lot.lot_number ?? '—'}</td>
              <td>${lot.qty_on_hand} ${lot.unit}</td>
              <td>${lot.expiry_date}</td>
              <td><span class="badge ${expired ? 'cancelled' : 'pending'}">${expired ? 'Expired' : 'Expiring soon'}</span></td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      `);
    } catch (err) { reportError(err); }
  }

  // ── Inventory lots ─────────────────────────────────────────────────────────
  async function loadLots() {
    const el = container.querySelector('#tab-lots');
    mount(el, html`<div class="loading">Loading…</div>`);
    const filter = { from: '', to: '', product: '' };
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('inventory_lots')
        .select('*, products(name,unit), locations(name), storage_locations(code)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      if (!data?.length) { mount(el, html`<p class="muted">No inventory lots recorded yet.</p>`); return; }
      mount(el, html`
        <table class="data-table">
          <thead><tr><th>Product</th><th>Warehouse</th><th>Location</th><th>Lot</th><th>On hand</th><th>Reserved</th><th>Cost</th><th>Expiry</th></tr></thead>
          <tbody>${data.map((l) => html`<tr>
            <td>${l.products?.name ?? '—'}</td>
            <td>${l.locations?.name ?? '—'}</td>
            <td>${l.storage_locations?.code ?? '—'}</td>
            <td class="mono">${l.lot_number ?? '—'}</td>
            <td>${l.qty_on_hand} ${l.products?.unit ?? ''}</td>
            <td>${l.qty_reserved}</td>
            <td>${l.cost_price != null ? formatINR(l.cost_price) : '—'}</td>
            <td>${l.expiry_date ?? '—'}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      `);
    } catch (err) { reportError(err); }
  }

  // ── Storage locations ──────────────────────────────────────────────────────
  async function loadLocations(canEdit) {
    const el = container.querySelector('#tab-locations');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const sb = getSupabase();
      const { data: warehouses } = await sb.from('locations').select('id,name').eq('type','warehouse').order('name');
      const { data, error } = await sb.from('storage_locations').select('*, locations(name)').order('code');
      if (error) throw error;
      mount(el, html`
        <div class="page-sub-header">
          ${canEdit ? html`<button class="btn primary" id="new-loc-btn">+ Add location</button>` : ''}
        </div>
        ${!data?.length ? html`<p class="muted">No storage locations configured yet.</p>` : html`
          <table class="data-table">
            <thead><tr><th>Code</th><th>Warehouse</th><th>Zone</th><th>Status</th><th></th></tr></thead>
            <tbody>${data.map((loc) => html`<tr>
              <td><strong>${loc.code}</strong></td>
              <td>${loc.locations?.name ?? '—'}</td>
              <td>${loc.zone ?? '—'}</td>
              <td><span class="badge ${loc.is_active ? 'delivered' : 'cancelled'}">${loc.is_active ? 'Active' : 'Inactive'}</span></td>
              <td class="actions">${canEdit ? html`<button class="btn small ghost" data-edit-loc="${loc.id}">Edit</button>` : ''}</td>
            </tr>`).join('')}
            </tbody>
          </table>
        `}
      `);

      if (canEdit) {
        on(el, 'click', '#new-loc-btn', () => openLocationForm(null, warehouses ?? [], loadLocations.bind(null, canEdit)));
        on(el, 'click', '[data-edit-loc]', (_, btn) => {
          const loc = data?.find((l) => l.id === btn.dataset.editLoc);
          if (loc) openLocationForm(loc, warehouses ?? [], loadLocations.bind(null, canEdit));
        });
      }
    } catch (err) { reportError(err); }
  }

  // ── Movements log ──────────────────────────────────────────────────────────
  async function loadMovements() {
    const el = container.querySelector('#tab-movements');
    mount(el, html`<div class="loading">Loading…</div>`);
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('inventory_movements')
        .select('*, products(name,unit), locations(name), profiles(full_name)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      if (!data?.length) { mount(el, html`<p class="muted">No movements yet.</p>`); return; }
      mount(el, html`
        <table class="data-table">
          <thead><tr><th>Date</th><th>Product</th><th>Kind</th><th>Qty</th><th>Warehouse</th><th>Reference</th><th>By</th></tr></thead>
          <tbody>${data.map((m) => html`<tr>
            <td>${m.created_at?.slice(0,16).replace('T',' ')}</td>
            <td>${m.products?.name ?? '—'}</td>
            <td><span class="badge ${m.kind === 'in' ? 'delivered' : m.kind === 'out' ? 'cancelled' : 'pending'}">${m.kind}</span></td>
            <td class="${m.qty < 0 ? 'red' : 'green'}">${m.qty > 0 ? '+' : ''}${m.qty} ${m.products?.unit ?? ''}</td>
            <td>${m.locations?.name ?? '—'}</td>
            <td class="mono">${m.reference_type ? `${m.reference_type} ${m.reference_id?.slice(0,8) ?? ''}` : '—'}</td>
            <td>${m.profiles?.full_name ?? '—'}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      `);
    } catch (err) { reportError(err); }
  }
}

function openLocationForm(loc, warehouses, onSave) {
  const m = modal(html`
    <h4>${loc ? 'Edit location' : 'New storage location'}</h4>
    <form id="loc-form" class="stack" novalidate>
      <label class="field"><span class="label">Warehouse</span>
        <select class="select" name="warehouse_id" required>
          <option value="">— choose —</option>
          ${warehouses.map((w) => html`<option value="${w.id}" ${w.id === loc?.warehouse_id ? 'selected' : ''}>${w.name}</option>`)}
        </select></label>
      <label class="field"><span class="label">Location code</span>
        <input class="input" name="code" value="${loc?.code ?? ''}" required maxlength="20" placeholder="A-01"></label>
      <label class="field"><span class="label">Zone (optional)</span>
        <input class="input" name="zone" value="${loc?.zone ?? ''}" maxlength="40" placeholder="Dry / Cold / Ambient"></label>
      <label class="check"><input type="checkbox" name="is_active" ${loc?.is_active !== false ? 'checked' : ''}> Active</label>
      <div><button class="btn primary" type="submit">Save</button></div>
    </form>
  `);
  on(m, 'submit', '#loc-form', async (e, form) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const sb = getSupabase();
      if (loc) {
        await sb.from('storage_locations').update({
          warehouse_id: fd.get('warehouse_id'), code: fd.get('code'),
          zone: fd.get('zone') || null, is_active: form.elements.is_active.checked,
        }).eq('id', loc.id).throwOnError();
      } else {
        await sb.from('storage_locations').insert({
          warehouse_id: fd.get('warehouse_id'), code: fd.get('code'),
          zone: fd.get('zone') || null, is_active: true,
        }).throwOnError();
      }
      toast('Location saved', 'success');
      m.remove();
      onSave();
    } catch (err) { reportError(err); }
  });
}
