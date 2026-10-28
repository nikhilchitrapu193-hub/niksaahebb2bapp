// =============================================================================
// coupons.js — Settings → Coupons admin screen.
//
// Lets admins create and manage discount coupons. Coupons are validated by the
// database (coupon_check / apply_coupon_to_order) — the UI shows configuration
// and usage history only.
// =============================================================================

import { html, mount, on, toast, modal, money } from '../../core/ui.js';
import { listCoupons, saveCoupon, listCouponRedemptions } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { COUPON_KINDS } from '../../core/config.js';

const BADGE = { true: 'delivered', false: 'cancelled' };

/** Render the Coupons sub-section inside Settings. Called by admin/settings.js. */
export function renderCoupons(container, me) {
  mount(container, html`
    <div class="page-header">
      <h2>Coupons</h2>
      ${can(me, 'settings', 'edit') ? html`<button class="btn btn-primary" id="new-coupon-btn">+ New coupon</button>` : ''}
    </div>
    <div id="coupons-list">Loading…</div>
  `);

  on(container, '#new-coupon-btn', 'click', () => openCouponForm(null, me, () => reload()));
  reload();

  async function reload() {
    const rows = await listCoupons().catch(e => { toast(e.message, 'error'); return []; });
    const list = container.querySelector('#coupons-list');
    if (!rows.length) { mount(list, html`<p class="muted">No coupons yet.</p>`); return; }

    mount(list, html`
      <table class="data-table">
        <thead><tr>
          <th>Code</th><th>Type</th><th>Value</th><th>Min order</th>
          <th>Uses</th><th>Valid</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(c => html`
          <tr>
            <td><strong>${c.code}</strong></td>
            <td>${COUPON_KINDS[c.kind]?.label ?? c.kind}</td>
            <td>${c.kind === 'percent' ? `${c.value}%` : money(c.value)}</td>
            <td>${c.min_order ? money(c.min_order) : '—'}</td>
            <td>${c.redemption_count ?? '—'}${c.max_uses ? ` / ${c.max_uses}` : ''}</td>
            <td>${c.valid_from ? c.valid_from.slice(0, 10) : ''}${c.valid_to ? ' – ' + c.valid_to.slice(0, 10) : ''}</td>
            <td><span class="badge ${BADGE[String(c.is_active)]}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
            <td class="actions">
              ${can(me, 'settings', 'edit') ? html`<button class="btn btn-sm" data-edit="${c.id}">Edit</button>` : ''}
              <button class="btn btn-sm" data-usage="${c.id}">Usage</button>
            </td>
          </tr>
        `).join('')}</tbody>
      </table>
    `);

    on(list, '[data-edit]', 'click', e => {
      const row = rows.find(r => r.id === e.target.dataset.edit);
      if (row) openCouponForm(row, me, reload);
    });

    on(list, '[data-usage]', 'click', async e => {
      const row = rows.find(r => r.id === e.target.dataset.usage);
      if (!row) return;
      const redemptions = await listCouponRedemptions(row.id).catch(err => { toast(err.message, 'error'); return []; });
      modal(html`
        <h3>Usage — ${row.code}</h3>
        ${!redemptions.length ? html`<p class="muted">No redemptions yet.</p>` : html`
          <table class="data-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Discount</th><th>Date</th></tr></thead>
            <tbody>${redemptions.map(r => html`
              <tr>
                <td>${r.orders?.order_number ?? '—'}</td>
                <td>${r.restaurants?.name ?? '—'}</td>
                <td>${money(r.discount_amount)}</td>
                <td>${r.created_at?.slice(0, 10)}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        `}
      `);
    });
  }
}

function openCouponForm(coupon, me, onSave) {
  const isNew = !coupon;
  modal(html`
    <h3>${isNew ? 'New coupon' : 'Edit coupon'}</h3>
    <form id="coupon-form">
      <label>Code *
        <input name="code" type="text" required value="${coupon?.code ?? ''}"
               placeholder="SUMMER20" style="text-transform:uppercase" ${!isNew ? 'readonly' : ''}>
      </label>
      <label>Type *
        <select name="kind">
          ${Object.entries(COUPON_KINDS).map(([k, v]) =>
            `<option value="${k}" ${coupon?.kind === k ? 'selected' : ''}>${v.label}</option>`
          ).join('')}
        </select>
      </label>
      <div class="form-row">
        <label>Discount value *
          <input name="value" type="number" min="0.01" step="0.01" required value="${coupon?.value ?? ''}">
        </label>
        <label>Min order (₹)
          <input name="min_order" type="number" min="0" step="1" value="${coupon?.min_order ?? 0}">
        </label>
      </div>
      <div class="form-row">
        <label>Max discount (₹, optional)
          <input name="max_discount" type="number" min="0" step="1" value="${coupon?.max_discount ?? ''}">
        </label>
        <label>Max total uses (optional)
          <input name="max_uses" type="number" min="1" step="1" value="${coupon?.max_uses ?? ''}">
        </label>
        <label>Per customer limit
          <input name="per_customer" type="number" min="1" step="1" value="${coupon?.per_customer ?? 1}">
        </label>
      </div>
      <div class="form-row">
        <label>Valid from
          <input name="valid_from" type="date" value="${coupon?.valid_from?.slice(0, 10) ?? ''}">
        </label>
        <label>Valid to
          <input name="valid_to" type="date" value="${coupon?.valid_to?.slice(0, 10) ?? ''}">
        </label>
      </div>
      <label>Description (optional)
        <input name="description" type="text" value="${coupon?.description ?? ''}">
      </label>
      <label class="checkbox-row">
        <input name="is_active" type="checkbox" ${(coupon?.is_active ?? true) ? 'checked' : ''}>
        Active
      </label>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save coupon</button>
      </div>
    </form>
  `);

  document.querySelector('#coupon-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await saveCoupon({
        id: coupon?.id,
        code: f.get('code'),
        kind: f.get('kind'),
        value: f.get('value'),
        min_order: f.get('min_order') || 0,
        max_discount: f.get('max_discount') || null,
        max_uses: f.get('max_uses') || null,
        per_customer: f.get('per_customer') || 1,
        valid_from: f.get('valid_from') || null,
        valid_to: f.get('valid_to') || null,
        description: f.get('description') || null,
        is_active: f.get('is_active') === 'on',
      });
      toast('Coupon saved');
      document.querySelector('.modal-overlay')?.remove();
      onSave();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
