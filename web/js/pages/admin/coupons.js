// =============================================================================
// coupons.js — Settings → Coupons (migration 021). A code with a % or ₹ discount
// on the subtotal, a minimum order, an optional cap, validity dates, an
// optional sector and a once-per-customer rule. The cart previews a code with
// validate_coupon(); place_order applies it. Editing needs settings:edit.
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listCoupons, saveCoupon, listCouponRedemptions, listSectors } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { COUPON_KINDS } from '../../core/config.js';
import { settingsTabs } from './settings.js';

export async function renderCoupons(container, me) {
  const canEdit = can(me, 'settings', 'edit');
  let coupons = [];
  let sectors = [];
  async function load() { [coupons, sectors] = await Promise.all([listCoupons(), listSectors()]); draw(); }
  const sectorName = (code) => (code ? (sectors.find((s) => s.code === code)?.name ?? code) : 'Every sector');
  const describe = (c) => (c.kind === 'percent' ? `${Number(c.value)}% off${c.max_discount ? ` (up to ${formatINR(c.max_discount)})` : ''}` : `${formatINR(c.value)} off`);

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Coupons</h1><p>Codes customers type in the cart. The discount comes off the subtotal, before GST.</p></div>
        ${canEdit ? html`<button class="btn primary" id="new-coupon">New coupon</button>` : ''}</div>
      ${settingsTabs(me, '#coupons')}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Code</th><th>Discount</th><th>Min order</th><th>Valid</th><th>Who</th><th class="right">Used</th><th>Status</th><th></th></tr></thead>
        <tbody>${coupons.length === 0 ? html`<tr><td colspan="8"><div class="empty">No coupons yet.</div></td></tr>` : coupons.map((c) => html`<tr data-coupon="${c.id}">
          <td><strong>${c.code}</strong>${c.description ? html`<div class="muted tiny">${c.description}</div>` : ''}</td>
          <td>${describe(c)}</td>
          <td class="num">${Number(c.min_order_value) > 0 ? formatINR(c.min_order_value) : '—'}</td>
          <td class="small nowrap">${formatDate(c.valid_from)} → ${c.valid_to ? formatDate(c.valid_to) : 'open'}</td>
          <td class="small">${sectorName(c.sector_code)}${c.once_per_customer ? ' · once each' : ''}</td>
          <td class="right num"><a href="#" data-uses="${c.id}">${c.uses}${c.max_uses ? ` / ${c.max_uses}` : ''}</a></td>
          <td>${c.is_active ? html`<span class="badge delivered">active</span>` : html`<span class="badge inactive">off</span>`}</td>
          <td class="right">${canEdit ? html`<button class="btn small" data-edit="${c.id}">Edit</button>` : ''}</td></tr>`)}</tbody></table></div></div>`);
  }

  function edit(c = {}) {
    const { el, close } = openModal(html`<form id="coupon-form" class="stack" novalidate>
      <div class="form-grid">
        <label class="field"><span class="label">Code</span><input class="input" name="code" value="${c.code ?? ''}" maxlength="20" pattern="[A-Za-z0-9-]{3,20}" required style="text-transform:uppercase" ${c.id ? 'disabled' : ''}><span class="hint">3–20 letters, digits or dashes</span></label>
        <label class="field"><span class="label">Description (internal)</span><input class="input" name="description" value="${c.description ?? ''}" maxlength="160"></label>
        <label class="field"><span class="label">Type</span><select class="select" name="kind">${Object.entries(COUPON_KINDS).map(([k, v]) => html`<option value="${k}" ${k === (c.kind ?? 'percent') ? 'selected' : ''}>${v.label}</option>`)}</select></label>
        <label class="field"><span class="label">Value</span><input class="input num" name="value" type="number" min="0.01" step="0.01" value="${c.value ?? ''}" required></label>
        <label class="field"><span class="label">Minimum order (₹)</span><input class="input num" name="min_order_value" type="number" min="0" step="1" value="${c.min_order_value ?? 0}"></label>
        <label class="field"><span class="label">Cap for % coupons (₹, blank = none)</span><input class="input num" name="max_discount" type="number" min="1" step="1" value="${c.max_discount ?? ''}"></label>
        <label class="field"><span class="label">Valid from</span><input class="input" name="valid_from" type="date" value="${c.valid_from ?? ''}"></label>
        <label class="field"><span class="label">Valid to (blank = open)</span><input class="input" name="valid_to" type="date" value="${c.valid_to ?? ''}"></label>
        <label class="field"><span class="label">Sector</span><select class="select" name="sector_code"><option value="">Every sector</option>${sectors.map((s) => html`<option value="${s.code}" ${s.code === c.sector_code ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label class="field"><span class="label">Total uses allowed (blank = unlimited)</span><input class="input num" name="max_uses" type="number" min="1" step="1" value="${c.max_uses ?? ''}"></label>
        <label class="check"><input type="checkbox" name="once_per_customer" ${c.once_per_customer !== false ? 'checked' : ''}> Once per customer</label>
        <label class="check"><input type="checkbox" name="is_active" ${c.is_active !== false ? 'checked' : ''}> Active</label>
      </div>
      <p class="form-error" id="coupon-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, { title: c.id ? `Edit ${c.code}` : 'New coupon', wide: true });
    const form = $('#coupon-form', el);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      v.code = c.code ?? v.code; v.once_per_customer = form.elements.once_per_customer.checked; v.is_active = form.elements.is_active.checked;
      if (!form.checkValidity() || !(Number(v.value) > 0)) { $('#coupon-error', el).textContent = 'Check the code and the value.'; return; }
      if (v.kind === 'percent' && Number(v.value) > 100) { $('#coupon-error', el).textContent = 'A percentage cannot be above 100.'; return; }
      try { await withBusy($('button[type="submit"]', form), () => saveCoupon({ ...c, ...v })); toast('Coupon saved', 'success'); close(); await load(); }
      catch (error) { $('#coupon-error', el).textContent = error.message; }
    };
  }

  on(container, 'click', '#new-coupon', () => edit());
  on(container, 'click', '[data-edit]', (_e, b) => edit(coupons.find((c) => c.id === b.dataset.edit)));
  on(container, 'click', '[data-uses]', async (e, a) => {
    e.preventDefault();
    try {
      const rows = await listCouponRedemptions(a.dataset.uses);
      openModal(html`<div class="stack"><div class="table-wrap"><table class="table"><thead><tr><th>Order</th><th>Customer</th><th class="right">Discount</th><th>When</th></tr></thead>
        <tbody>${rows.length === 0 ? html`<tr><td colspan="4" class="muted small">Not used yet.</td></tr>` : rows.map((r) => html`<tr><td>${r.orders?.order_number ?? '—'}</td><td>${r.restaurants?.name ?? '—'}</td><td class="right money">${formatINR(r.discount)}</td><td class="muted small">${formatDate(r.created_at)}</td></tr>`)}</tbody></table></div>
        <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div></div>`, { title: 'Redemptions' });
    } catch (error) { reportError(error); }
  });

  await load();
}
