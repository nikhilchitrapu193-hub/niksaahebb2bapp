// =============================================================================
// slots.js — Settings → Delivery slots: the cut-off hour (when a slot stops
// taking orders) and an optional per-day capacity, per city and slot. No row =
// the slot is always open and uncapped. Enforced by place_order (migration 013).
// =============================================================================

import { html, mount, on, $, openModal, confirmDialog, reportError, toast, withBusy } from '../../core/ui.js';
import { listSlotConfig, saveSlotConfig, deleteSlotConfig, listCities } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { DELIVERY_SLOTS } from '../../core/config.js';
import { settingsTabs } from './settings.js';

export async function renderSlots(container, me) {
  const canEdit = can(me, 'settings', 'edit');
  let [rows, cities] = await Promise.all([listSlotConfig(), listCities()]);

  async function reload() { rows = await listSlotConfig(); draw(); }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Delivery slots</h1><p>Cut-off time and capacity per slot. No row = always open.</p></div>
        ${canEdit ? html`<button class="btn primary" id="new">New slot rule</button>` : ''}</div>
      ${settingsTabs(me, '#slots')}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>City</th><th>Slot</th><th class="right">Cut-off (IST)</th><th class="right">Capacity / day</th><th>Active</th><th></th></tr></thead>
        <tbody>${rows.length === 0 ? html`<tr><td colspan="6"><div class="empty">No cut-offs set: every slot takes orders any time.</div></td></tr>` : rows.map((r) => html`
          <tr><td>${r.cities?.name ?? 'Every city'}</td><td>${DELIVERY_SLOTS[r.slot]?.label ?? r.slot}</td>
            <td class="right num">${String(r.cutoff_hour).padStart(2, '0')}:00</td><td class="right num">${r.capacity_orders ?? '—'}</td>
            <td>${r.is_active ? 'Yes' : 'No'}</td>
            <td class="right">${canEdit ? html`<button class="btn small" data-edit="${r.id}">Edit</button> <button class="btn small danger" data-del="${r.id}">✕</button>` : ''}</td></tr>`)}</tbody></table></div></div>
      <p class="muted small" style="margin-top:var(--space-3)">Express closes at the cut-off hour the same day; scheduled slots close a next-day order at the cut-off the day before.</p>`);
  }

  on(container, 'click', '#new', () => form(null));
  on(container, 'click', '[data-edit]', (_e, el) => form(rows.find((r) => r.id === el.dataset.edit)));
  on(container, 'click', '[data-del]', async (_e, el) => {
    if (!(await confirmDialog('Remove this slot rule? The slot becomes always-open.', { confirmText: 'Remove', danger: true }))) return;
    try { await deleteSlotConfig(el.dataset.del); await reload(); } catch (error) { reportError(error); }
  });

  function form(rule) {
    const { el, close } = openModal(html`
      <form id="sc" class="stack" novalidate>
        <div class="form-grid">
          <label class="field"><span class="label">City</span><select class="select" name="city_id"><option value="">Every city</option>${cities.map((c) => html`<option value="${c.id}" ${rule?.city_id === c.id ? 'selected' : ''}>${c.name}</option>`)}</select></label>
          <label class="field"><span class="label">Slot</span><select class="select" name="slot" required>${Object.entries(DELIVERY_SLOTS).map(([k, v]) => html`<option value="${k}" ${rule?.slot === k ? 'selected' : ''}>${v.label}</option>`)}</select></label>
          <label class="field"><span class="label">Cut-off hour (0–23, IST)</span><input class="input" name="cutoff_hour" type="number" min="0" max="23" step="1" value="${rule?.cutoff_hour ?? 18}" required></label>
          <label class="field"><span class="label">Capacity / day (optional)</span><input class="input" name="capacity_orders" type="number" min="1" step="1" value="${rule?.capacity_orders ?? ''}"></label>
        </div>
        <label class="check"><input type="checkbox" name="is_active" ${rule?.is_active ?? true ? 'checked' : ''}> Active</label>
        <p class="form-error" id="sc-error" role="alert"></p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
      </form>`, { title: rule ? 'Edit slot rule' : 'New slot rule' });
    $('#sc', el).onsubmit = async (event) => {
      event.preventDefault();
      const f = event.target;
      try {
        await withBusy($('button[type="submit"]', f), () => saveSlotConfig({
          id: rule?.id, city_id: f.elements.city_id.value || null, slot: f.elements.slot.value,
          cutoff_hour: f.elements.cutoff_hour.value, capacity_orders: f.elements.capacity_orders.value, is_active: f.elements.is_active.checked,
        }));
        toast('Saved', 'success'); close(); await reload();
      } catch (error) { $('#sc-error', el).textContent = /unique|duplicate/i.test(error.message) ? 'A rule for that city and slot already exists.' : error.message; }
    };
  }

  draw();
}
