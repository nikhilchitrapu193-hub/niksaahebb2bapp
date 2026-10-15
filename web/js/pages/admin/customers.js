// =============================================================================
// customers.js — customer accounts of every sector: approve new sign-ups,
// suspend or reinstate, set sector / city / warehouse / pin code and the
// per-customer overrides of the sector terms (MOV, delivery fee, credit days).
//
// A customer can only be approved once a warehouse serves them (from their
// pin code, or set here); the database refuses otherwise (set_customer_status).
// =============================================================================

import { html, mount, on, $, formatDate, formatINR, statusBadge, reportError, toast, confirmDialog, openModal, withBusy } from '../../core/ui.js';
import { listRestaurants, setRestaurantStatus, listOutstandingBalances, saveCustomerTerms, listSectors, listCities, listWarehouses } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';

export async function renderCustomers(container, me, onPendingChange) {
  const [restaurants, balances, sectors, cities, warehouses] = await Promise.all([
    listRestaurants(), listOutstandingBalances(), listSectors(), listCities(), listWarehouses(),
  ]);
  const owed = Object.fromEntries(balances.map((b) => [b.restaurant_id, b]));
  const sectorName = Object.fromEntries(sectors.map((s) => [s.code, s.name]));
  const cityName = Object.fromEntries(cities.map((c) => [c.id, c.name]));
  const warehouseName = Object.fromEntries(warehouses.map((w) => [w.id, w.name]));
  const pending = restaurants.filter((r) => r.status === 'pending').length;
  const canApprove = can(me, 'customers', 'approve');
  const canEdit = can(me, 'customers', 'edit');
  onPendingChange?.(pending);

  mount(container, html`
    <div class="page-head"><div><h1>Customers</h1><p>${restaurants.length} accounts · ${pending} awaiting approval</p></div>
      ${can(me, 'customers', 'export') ? html`<button class="btn" id="export">Export CSV</button>` : ''}</div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Customer</th><th>Sector · city</th><th>Contact</th><th class="right">Outstanding</th><th>Joined</th><th>Status</th><th></th></tr></thead>
      <tbody>${restaurants.length === 0
        ? html`<tr><td colspan="7"><div class="empty">No customers have registered yet.</div></td></tr>`
        : restaurants.map((r) => html`<tr>
          <td><strong>${r.name}</strong><div class="muted small">${r.address || ''}${r.pincode ? ` · ${r.pincode}` : ''}</div>
            ${r.gstin ? html`<div class="muted tiny">GSTIN ${r.gstin}</div>` : ''}
            ${r.fssai ? html`<div class="muted tiny">FSSAI ${r.fssai}</div>` : html`<div class="tiny" style="color:var(--accent)">No FSSAI number</div>`}</td>
          <td class="small">${sectorName[r.sector_code] ?? r.sector_code}<div class="muted tiny">${cityName[r.city_id] ?? '—'} · ${r.warehouse_id ? warehouseName[r.warehouse_id] : html`<span style="color:var(--danger)">no warehouse</span>`}</div></td>
          <td>${r.phone || '—'}</td>
          <td class="right num">${owed[r.id] ? html`<strong>${formatINR(owed[r.id].outstanding)}</strong><div class="muted tiny">${owed[r.id].unpaid_orders} unpaid</div>` : html`<span class="muted">—</span>`}</td>
          <td class="nowrap muted">${formatDate(r.created_at)}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="right nowrap">
            ${canEdit ? html`<button class="btn small" data-terms="${r.id}">Terms</button>` : ''}
            ${canApprove && r.status !== 'approved' ? html`<button class="btn primary small" data-set="approved" data-id="${r.id}">Approve</button>` : ''}
            ${canApprove && r.status === 'approved' ? html`<button class="btn danger small" data-set="suspended" data-id="${r.id}">Suspend</button>` : ''}
          </td></tr>`)}
      </tbody></table></div></div>`);

  const refresh = () => renderCustomers(container, me, onPendingChange);

  on(container, 'click', '[data-set]', async (_e, button) => {
    const status = button.dataset.set;
    if (status === 'suspended' && !(await confirmDialog('Suspend this customer? They will not be able to place orders.', { confirmText: 'Suspend', danger: true }))) return;
    try {
      await setRestaurantStatus(button.dataset.id, status);
      toast(`Customer ${status}`, 'success');
      refresh();
    } catch (error) { reportError(error); }
  });

  on(container, 'click', '[data-terms]', (_e, button) =>
    termsForm(restaurants.find((r) => r.id === button.dataset.terms), { sectors, cities, warehouses }, refresh));

  on(container, 'click', '#export', () => downloadCsv('customers.csv', restaurants, [
    { key: 'name', label: 'Customer' },
    { label: 'Sector', value: (r) => sectorName[r.sector_code] ?? r.sector_code },
    { label: 'City', value: (r) => cityName[r.city_id] ?? '' },
    { label: 'Warehouse', value: (r) => warehouseName[r.warehouse_id] ?? '' },
    { key: 'pincode', label: 'Pin code' },
    { key: 'phone', label: 'Phone' },
    { key: 'gstin', label: 'GSTIN' },
    { key: 'fssai', label: 'FSSAI' },
    { key: 'status', label: 'Status' },
    { label: 'Outstanding', value: (r) => owed[r.id]?.outstanding ?? 0 },
    { key: 'created_at', label: 'Joined' },
  ]));
}

/** Sector, delivery area and term overrides for one customer. */
function termsForm(customer, { sectors, cities, warehouses }, onSaved) {
  const initial = sectors.find((s) => s.code === customer.sector_code) ?? sectors[0];
  const { el, close } = openModal(html`
    <form id="terms-form" class="stack" novalidate>
      <div class="form-grid">
        <label class="field"><span class="label">Sector</span><select class="select" name="sector_code">
          ${sectors.map((s) => html`<option value="${s.code}" ${s.code === customer.sector_code ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label class="field"><span class="label">City</span><select class="select" name="city_id">
          ${cities.map((c) => html`<option value="${c.id}" ${c.id === customer.city_id ? 'selected' : ''}>${c.name}</option>`)}</select></label>
        <label class="field"><span class="label">Pin code</span><input class="input" name="pincode" value="${customer.pincode ?? ''}" pattern="[1-9][0-9]{5}" maxlength="6" inputmode="numeric"></label>
        <label class="field"><span class="label">Served from warehouse</span><select class="select" name="warehouse_id">
          <option value="">— none (cannot order) —</option>
          ${warehouses.map((w) => html`<option value="${w.id}" ${w.id === customer.warehouse_id ? 'selected' : ''}>${w.name}</option>`)}</select>
          <span class="hint">Set automatically from the pin code at sign-up when we serve it.</span></label>
      </div>
      <h3>Overrides <span class="muted small">(leave blank to use the sector's terms)</span></h3>
      <div class="form-grid">
        <label class="field"><span class="label">Minimum order (₹)</span><input class="input num" type="number" min="0" name="min_order_value" value="${customer.min_order_value ?? ''}" placeholder="${Number(initial.min_order_value)}"></label>
        <label class="field"><span class="label">Delivery fee below minimum (₹)</span><input class="input num" type="number" min="0" name="delivery_fee_below_mov" value="${customer.delivery_fee_below_mov ?? ''}" placeholder="${Number(initial.delivery_fee_below_mov)}"></label>
        <label class="field"><span class="label">Credit days</span><input class="input num" type="number" min="0" max="365" name="credit_days" value="${customer.credit_days ?? ''}" placeholder="${initial.credit_days}"></label>
      </div>
      <p class="form-error" id="terms-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, { title: `Terms: ${customer.name}`, wide: true });

  // Placeholders show the sector defaults; refresh them when the sector changes.
  on(el, 'change', '[name=sector_code]', (_e, select) => {
    const s = sectors.find((x) => x.code === select.value);
    $('[name=min_order_value]', el).placeholder = Number(s.min_order_value);
    $('[name=delivery_fee_below_mov]', el).placeholder = Number(s.delivery_fee_below_mov);
    $('[name=credit_days]', el).placeholder = s.credit_days;
  });

  $('#terms-form', el).onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.checkValidity()) { $('#terms-error', el).textContent = 'Pin code must be 6 digits.'; return; }
    try {
      await withBusy($('button[type="submit"]', form), () => saveCustomerTerms(customer.id, Object.fromEntries(new FormData(form))));
      toast('Terms saved', 'success'); close(); onSaved();
    } catch (error) { $('#terms-error', el).textContent = error.message; }
  };
}
