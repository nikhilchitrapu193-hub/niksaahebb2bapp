// =============================================================================
// locations.js — cities, their warehouses, and the pin codes each warehouse
// delivers to (service zones). This is how a new city is switched on:
//   1. add the city  2. add a default warehouse  3. add its pin codes.
// Customers whose pin code matches a zone are served from that warehouse.
// Needs settings:view to open and settings:edit to change anything.
// =============================================================================

import { html, mount, on, $, openModal, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listCities, saveCity, listWarehouses, saveWarehouse, listServiceZones, saveServiceZone, deleteServiceZone } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { settingsTabs } from './settings.js';

export async function renderLocations(container, me) {
  const editable = can(me, 'settings', 'edit');
  let cities = [];
  let warehouses = [];
  let zones = [];

  async function load() {
    [cities, warehouses, zones] = await Promise.all([listCities(), listWarehouses(), listServiceZones()]);
    draw();
  }

  function draw() {
    const zonesOf = (warehouseId) => zones.filter((z) => z.warehouse_id === warehouseId);
    mount(container, html`
      <div class="page-head"><div><h1>Cities &amp; warehouses</h1><p>${cities.length} cities · ${warehouses.length} warehouses · ${zones.length} pin codes served</p></div>
        ${editable ? html`<button class="btn primary" id="add-city">Add city</button>` : ''}</div>
      ${settingsTabs(me, '#locations')}
      ${cities.length === 0 ? html`<div class="empty"><strong>No cities yet</strong>Add your first city to start.</div>` : ''}
      ${cities.map((city) => html`
        <section class="card" style="margin-bottom:var(--space-5)">
          <div class="card-head">
            <h2>${city.name} <span class="muted small">state ${city.state_code}${city.is_active ? '' : ' · inactive'}</span></h2>
            ${editable ? html`<div class="row"><button class="btn small" data-edit-city="${city.id}">Edit</button>
              <button class="btn small" data-add-wh="${city.id}">Add warehouse</button></div>` : ''}
          </div>
          ${warehouses.filter((w) => w.city_id === city.id).map((w) => html`
            <div class="card-pad" style="border-top:1px solid var(--line)">
              <div class="spread">
                <div><strong>${w.name}</strong>${w.is_default ? html` <span class="badge role">Default</span>` : ''}${w.is_active ? '' : html` <span class="badge inactive">Inactive</span>`}
                  <div class="muted small">${w.address || 'No address'}${w.phone ? ` · ${w.phone}` : ''}</div></div>
                ${editable ? html`<div class="row"><button class="btn small" data-edit-wh="${w.id}">Edit</button>
                  <button class="btn small" data-add-zone="${w.id}">Add pin code</button></div>` : ''}
              </div>
              <div class="chips" style="margin-top:var(--space-3)">
                ${zonesOf(w.id).length === 0 ? html`<span class="muted small">No pin codes yet — customers here cannot order until you add some.</span>` : ''}
                ${zonesOf(w.id).map((z) => html`<span class="chip" aria-pressed="${String(z.is_active)}" title="${z.area_name}">${z.pincode}${z.area_name ? ` · ${z.area_name}` : ''}
                  ${editable ? html` <button class="icon-btn" style="font-size:1rem;padding:0 4px" data-del-zone="${z.id}" aria-label="Remove ${z.pincode}">×</button>` : ''}</span>`)}
              </div>
            </div>`)}
          ${warehouses.some((w) => w.city_id === city.id) ? '' : html`<div class="card-pad muted small">No warehouse yet. Add one and mark it default.</div>`}
        </section>`)}`);
  }

  on(container, 'click', '#add-city', () => cityForm({}, load));
  on(container, 'click', '[data-edit-city]', (_e, b) => cityForm(cities.find((c) => c.id === b.dataset.editCity), load));
  on(container, 'click', '[data-add-wh]', (_e, b) => warehouseForm({ city_id: b.dataset.addWh }, load));
  on(container, 'click', '[data-edit-wh]', (_e, b) => warehouseForm(warehouses.find((w) => w.id === b.dataset.editWh), load));
  on(container, 'click', '[data-add-zone]', (_e, b) => zoneForm({ warehouse_id: b.dataset.addZone }, load));
  on(container, 'click', '[data-del-zone]', async (_e, b) => {
    const zone = zones.find((z) => z.id === b.dataset.delZone);
    if (!(await confirmDialog(`Stop serving pin code ${zone.pincode}? Customers there will not be able to order.`, { confirmText: 'Remove', danger: true }))) return;
    try { await deleteServiceZone(zone.id); toast('Pin code removed', 'success'); await load(); } catch (error) { reportError(error); }
  });

  await load();
}

/** Small form inside a modal; `fields` is html``; onSave(values) does the write. */
function formModal(title, fields, onSave) {
  const { el, close } = openModal(html`
    <form id="loc-form" class="stack" novalidate>
      ${fields}
      <p class="form-error" id="loc-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, { title });
  $('#loc-form', el).onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.checkValidity()) { $('#loc-error', el).textContent = 'Please fill in the required fields.'; return; }
    const values = Object.fromEntries(new FormData(form));
    // Checkboxes are missing from FormData when unticked; read them directly.
    form.querySelectorAll('input[type="checkbox"]').forEach((box) => { values[box.name] = box.checked; });
    try {
      await withBusy($('button[type="submit"]', form), () => onSave(values));
      toast('Saved', 'success'); close();
    } catch (error) { $('#loc-error', el).textContent = error.message; }
  };
}

function cityForm(city, onSaved) {
  formModal(city.id ? `Edit ${city.name}` : 'Add city', html`
    <label class="field"><span class="label">City name</span><input class="input" name="name" value="${city.name ?? ''}" required maxlength="80"></label>
    <div class="form-grid">
      <label class="field"><span class="label">GST state code</span><input class="input" name="state_code" value="${city.state_code ?? '37'}" required pattern="[0-9]{2}" maxlength="2"><span class="hint">37 = Andhra Pradesh, 36 = Telangana</span></label>
      <label class="field"><span class="label">Sort order</span><input class="input" name="sort_order" type="number" value="${city.sort_order ?? 0}"></label>
    </div>
    <label class="check"><input type="checkbox" name="is_active" ${(city.is_active ?? true) ? 'checked' : ''}> Active (customers can sign up here)</label>`,
  (v) => saveCity({ ...v, id: city.id }).then(onSaved));
}

function warehouseForm(warehouse, onSaved) {
  formModal(warehouse.id ? `Edit ${warehouse.name}` : 'Add warehouse', html`
    <label class="field"><span class="label">Warehouse name</span><input class="input" name="name" value="${warehouse.name ?? ''}" required maxlength="80"></label>
    <label class="field"><span class="label">Address</span><textarea class="textarea" name="address" rows="2" maxlength="400">${warehouse.address ?? ''}</textarea></label>
    <label class="field"><span class="label">Phone</span><input class="input" name="phone" value="${warehouse.phone ?? ''}" maxlength="20"></label>
    <label class="check"><input type="checkbox" name="is_default" ${warehouse.is_default ? 'checked' : ''}> Default warehouse for this city</label>
    <label class="check"><input type="checkbox" name="is_active" ${(warehouse.is_active ?? true) ? 'checked' : ''}> Active</label>`,
  (v) => saveWarehouse({ ...v, id: warehouse.id, city_id: warehouse.city_id }).then(onSaved));
}

function zoneForm(zone, onSaved) {
  formModal('Add pin code', html`
    <div class="form-grid">
      <label class="field"><span class="label">Pin code</span><input class="input" name="pincode" required pattern="[1-9][0-9]{5}" maxlength="6" inputmode="numeric" placeholder="530001"></label>
      <label class="field"><span class="label">Area name (optional)</span><input class="input" name="area_name" maxlength="80" placeholder="MVP Colony"></label>
    </div>`,
  (v) => saveServiceZone({ ...v, warehouse_id: zone.warehouse_id }).then(onSaved));
}
