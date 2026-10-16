// =============================================================================
// delivery-charges.js — Fulfilment → Delivery charges: a fee per city and / or
// slot with a free-above threshold. The most specific active rule wins; with no
// rule the order falls back to the sector's minimum-order fee. Used by
// place_order (migration 013).
// =============================================================================

import { html, mount, on, $, formatINR, openModal, confirmDialog, reportError, toast, withBusy } from '../../core/ui.js';
import { listDeliveryCharges, saveDeliveryCharge, deleteDeliveryCharge, listCities } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { DELIVERY_SLOTS } from '../../core/config.js';
import { fulfilmentTabs } from './fulfilment.js';

export async function renderDeliveryCharges(container, me) {
  const canEdit = can(me, 'fulfilment', 'edit');
  let [rules, cities] = await Promise.all([listDeliveryCharges(), listCities()]);

  async function reload() { rules = await listDeliveryCharges(); draw(); }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Delivery charges</h1><p>${rules.length} rule${rules.length === 1 ? '' : 's'} · the most specific active rule wins</p></div>
        ${canEdit ? html`<button class="btn primary" id="new">New rule</button>` : ''}</div>
      ${fulfilmentTabs('#delivery-charges')}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>City</th><th>Slot</th><th class="right">Fee</th><th class="right">Free above</th><th>Active</th><th></th></tr></thead>
        <tbody>${rules.length === 0 ? html`<tr><td colspan="6"><div class="empty">No rules: orders use the sector's minimum-order fee.</div></td></tr>` : rules.map((r) => html`
          <tr><td>${r.cities?.name ?? 'Every city'}</td><td>${r.slot ? DELIVERY_SLOTS[r.slot]?.label : 'Every slot'}</td>
            <td class="right num">${formatINR(r.fee)}</td><td class="right num">${r.free_above != null ? formatINR(r.free_above) : '—'}</td>
            <td>${r.is_active ? 'Yes' : 'No'}</td>
            <td class="right">${canEdit ? html`<button class="btn small" data-edit="${r.id}">Edit</button> <button class="btn small danger" data-del="${r.id}">✕</button>` : ''}</td></tr>`)}</tbody></table></div></div>`);
  }

  on(container, 'click', '#new', () => form(null));
  on(container, 'click', '[data-edit]', (_e, el) => form(rules.find((r) => r.id === el.dataset.edit)));
  on(container, 'click', '[data-del]', async (_e, el) => {
    if (!(await confirmDialog('Remove this delivery-charge rule?', { confirmText: 'Remove', danger: true }))) return;
    try { await deleteDeliveryCharge(el.dataset.del); await reload(); } catch (error) { reportError(error); }
  });

  function form(rule) {
    const { el, close } = openModal(html`
      <form id="dc" class="stack" novalidate>
        <div class="form-grid">
          <label class="field"><span class="label">City</span><select class="select" name="city_id"><option value="">Every city</option>${cities.map((c) => html`<option value="${c.id}" ${rule?.city_id === c.id ? 'selected' : ''}>${c.name}</option>`)}</select></label>
          <label class="field"><span class="label">Slot</span><select class="select" name="slot"><option value="">Every slot</option>${Object.entries(DELIVERY_SLOTS).map(([k, v]) => html`<option value="${k}" ${rule?.slot === k ? 'selected' : ''}>${v.label}</option>`)}</select></label>
          <label class="field"><span class="label">Fee (₹)</span><input class="input" name="fee" type="number" min="0" step="0.01" value="${rule?.fee ?? 0}" required></label>
          <label class="field"><span class="label">Free above (₹, optional)</span><input class="input" name="free_above" type="number" min="0" step="0.01" value="${rule?.free_above ?? ''}"></label>
        </div>
        <label class="check"><input type="checkbox" name="is_active" ${rule?.is_active ?? true ? 'checked' : ''}> Active</label>
        <p class="form-error" id="dc-error" role="alert"></p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save rule</button></div>
      </form>`, { title: rule ? 'Edit delivery charge' : 'New delivery charge' });
    $('#dc', el).onsubmit = async (event) => {
      event.preventDefault();
      const f = event.target;
      try {
        await withBusy($('button[type="submit"]', f), () => saveDeliveryCharge({
          id: rule?.id, city_id: f.elements.city_id.value || null, slot: f.elements.slot.value || null,
          fee: f.elements.fee.value, free_above: f.elements.free_above.value, is_active: f.elements.is_active.checked,
        }));
        toast('Saved', 'success'); close(); await reload();
      } catch (error) { $('#dc-error', el).textContent = /unique|duplicate/i.test(error.message) ? 'A rule for that city and slot already exists.' : error.message; }
    };
  }

  draw();
}
