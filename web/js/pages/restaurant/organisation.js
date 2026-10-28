// =============================================================================
// organisation.js — the Outlets and Team sections of the customer's Account
// page (migration 020). Outlets: delivery points with their own address, pin
// code (→ warehouse), phone, preferred slot and map pin. Team: the people who
// sign in to this account — owner, approvers, outlet managers — invited by
// email through the customer-users Edge Function.
// The owner manages both; an outlet manager sees their outlet and can set its
// map pin (Account → Map pin); approvers see everything read-only.
// =============================================================================

import { html, mount, on, $, openModal, reportError, toast, withBusy, formatDate } from '../../core/ui.js';
import { listOutlets, saveOutlet, listMyCustomerUsers, setCustomerUser, inviteCustomerUser, listCities } from '../../core/api.js';
import { DELIVERY_SLOTS, CUSTOMER_ROLES } from '../../core/config.js';
import { currentPosition } from '../../core/geo.js';
import { mapHref } from '../../core/notify.js';

/** Render the two sections into `container`; `state.terms` carries the caller's customer_role. */
export async function renderOrganisation(container, state) {
  const role = state.terms?.customer_role ?? 'owner';
  const isOwner = role === 'owner';
  const [outlets, members, cities] = await Promise.all([listOutlets().catch(() => []), listMyCustomerUsers().catch(() => []), listCities().catch(() => [])]);
  const cityName = Object.fromEntries(cities.map((c) => [c.id, c.name]));

  mount(container, html`
    <section class="card card-pad stack" id="outlets">
      <div class="spread"><h2>Outlets</h2>${isOwner ? html`<button class="btn small" id="add-outlet">Add an outlet</button>` : ''}</div>
      <p class="muted small">Each outlet has its own delivery address and pin code; pick the outlet when you place an order.</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Outlet</th><th>Address</th><th>Slot</th><th>Map pin</th><th></th></tr></thead>
        <tbody>${outlets.map((o) => html`<tr data-outlet-row="${o.id}">
          <td><strong>${o.name}</strong>${o.is_primary ? html` <span class="badge confirmed">primary</span>` : ''}${o.is_active ? '' : html` <span class="badge inactive">off</span>`}</td>
          <td class="small">${o.address}<div class="muted tiny">${cityName[o.city_id] ?? ''}${o.pincode ? ` · ${o.pincode}` : ''}${o.warehouse_id ? '' : html` · <span style="color:var(--danger)">not served yet</span>`}</div></td>
          <td class="small">${DELIVERY_SLOTS[o.default_slot]?.label ?? o.default_slot}</td>
          <td class="small">${o.lat != null ? html`<a href="${mapHref(o.lat, o.lng)}" target="_blank" rel="noopener">pinned</a>` : html`<span class="muted">—</span>`}</td>
          <td class="right">${isOwner ? html`<button class="btn small" data-edit-outlet="${o.id}">Edit</button>` : ''}</td></tr>`)}</tbody></table></div>
    </section>

    <section class="card card-pad stack" id="team" style="margin-top:var(--space-4)">
      <div class="spread"><h2>Team</h2>${isOwner ? html`<button class="btn small" id="invite-member">Invite a member</button>` : ''}</div>
      <p class="muted small">${CUSTOMER_ROLES.approver.hint} ${CUSTOMER_ROLES.outlet_manager.hint}</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Role</th><th>Outlet</th><th>Since</th><th></th></tr></thead>
        <tbody>${members.map((m) => html`<tr data-member-row="${m.user_id}">
          <td><strong>${m.full_name || '—'}</strong>${m.phone ? html`<div class="muted tiny">${m.phone}</div>` : ''}${m.is_active ? '' : html` <span class="badge inactive">disabled</span>`}</td>
          <td>${CUSTOMER_ROLES[m.role]?.label ?? m.role}</td>
          <td class="small">${m.role === 'outlet_manager' ? (m.outlet_name ?? 'All outlets') : 'All outlets'}</td>
          <td class="muted small">${formatDate(m.created_at)}</td>
          <td class="right">${isOwner && m.role !== 'owner' ? html`<button class="btn small" data-edit-member="${m.user_id}">Edit</button>` : ''}</td></tr>`)}</tbody></table></div>
    </section>`);

  function outletForm(o = {}) {
    const { el, close } = openModal(html`<form id="outlet-form" class="stack" novalidate>
      <div class="form-grid">
        <label class="field span-2"><span class="label">Outlet name</span><input class="input" name="name" value="${o.name ?? ''}" maxlength="120" required placeholder="Main kitchen, Officers' mess, Branch 2…"></label>
        <label class="field span-2"><span class="label">Delivery address</span><textarea class="textarea" name="address" rows="2" maxlength="400" required>${o.address ?? ''}</textarea></label>
        <label class="field"><span class="label">City</span><select class="select" name="cityId">${cities.map((c) => html`<option value="${c.id}" ${c.id === (o.city_id ?? state.me.restaurant?.city_id) ? 'selected' : ''}>${c.name}</option>`)}</select></label>
        <label class="field"><span class="label">Pin code</span><input class="input" name="pincode" value="${o.pincode ?? ''}" pattern="[1-9][0-9]{5}" maxlength="6" inputmode="numeric"><span class="hint">Decides which warehouse serves this outlet</span></label>
        <label class="field"><span class="label">Phone at this outlet</span><input class="input" name="phone" value="${o.phone ?? ''}" maxlength="20"></label>
        <label class="field"><span class="label">Usual slot</span><select class="select" name="defaultSlot">${Object.entries(DELIVERY_SLOTS).map(([k, v]) => html`<option value="${k}" ${k === (o.default_slot ?? 'morning') ? 'selected' : ''}>${v.label}</option>`)}</select></label>
        <div class="field span-2"><span class="label">Map pin</span><div class="row-wrap"><button class="btn small" type="button" id="outlet-locate">📍 Use my location</button><span class="hint" id="outlet-pin">${o.lat != null ? `Pinned at ${o.lat}, ${o.lng}` : 'Not set'}</span></div>
          <input type="hidden" name="lat" value="${o.lat ?? ''}"><input type="hidden" name="lng" value="${o.lng ?? ''}"></div>
        ${o.id && !o.is_primary ? html`<label class="check span-2"><input type="checkbox" name="isActive" ${o.is_active !== false ? 'checked' : ''}> Active (orders can be placed for this outlet)</label>` : ''}
      </div>
      <p class="form-error" id="outlet-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save outlet</button></div>
    </form>`, { title: o.id ? `Edit ${o.name}` : 'New outlet' });
    const form = $('#outlet-form', el);
    $('#outlet-locate', el).onclick = async () => {
      try { const { lat, lng } = await currentPosition(); form.elements.lat.value = lat; form.elements.lng.value = lng; $('#outlet-pin', el).textContent = `Pinned at ${lat}, ${lng}`; }
      catch (error) { $('#outlet-pin', el).textContent = error.message; }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      if (!form.checkValidity()) { $('#outlet-error', el).textContent = 'Name and address are required; the pin code must be 6 digits.'; return; }
      try {
        await withBusy($('button[type="submit"]', form), () => saveOutlet({ id: o.id, name: v.name, address: v.address, phone: v.phone, cityId: v.cityId, pincode: v.pincode,
          lat: v.lat === '' ? null : Number(v.lat), lng: v.lng === '' ? null : Number(v.lng), defaultSlot: v.defaultSlot, isActive: form.elements.isActive ? form.elements.isActive.checked : true }));
        toast('Outlet saved', 'success'); close(); await renderOrganisation(container, state);
      } catch (error) { $('#outlet-error', el).textContent = error.message; }
    };
  }

  function memberForm(m = null) {
    const { el, close } = openModal(html`<form id="member-form" class="stack" novalidate>
      ${m ? html`<p><strong>${m.full_name || 'Member'}</strong></p>` : html`<div class="form-grid">
        <label class="field"><span class="label">Name</span><input class="input" name="fullName" maxlength="120" required></label>
        <label class="field"><span class="label">Email</span><input class="input" name="email" type="email" required></label>
        <label class="field span-2"><span class="label">Phone (optional)</span><input class="input" name="phone" maxlength="20"></label></div>`}
      <label class="field"><span class="label">Role</span><select class="select" name="role">
        ${['outlet_manager', 'approver'].map((r) => html`<option value="${r}" ${r === (m?.role ?? 'outlet_manager') ? 'selected' : ''}>${CUSTOMER_ROLES[r].label} — ${CUSTOMER_ROLES[r].hint}</option>`)}</select></label>
      <label class="field" id="outlet-field"><span class="label">Outlet (outlet managers)</span><select class="select" name="outletId"><option value="">All outlets</option>
        ${outlets.map((o) => html`<option value="${o.id}" ${o.id === m?.outlet_id ? 'selected' : ''}>${o.name}</option>`)}</select></label>
      ${m ? html`<label class="check"><input type="checkbox" name="isActive" ${m.is_active ? 'checked' : ''}> Active (can sign in and order)</label>` : html`<p class="muted small">They get an email with a link to set a password; they then sign in on the customer login page.</p>`}
      <p class="form-error" id="member-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${m ? 'Save' : 'Send invite'}</button></div>
    </form>`, { title: m ? 'Edit member' : 'Invite a member' });
    const form = $('#member-form', el);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      try {
        await withBusy($('button[type="submit"]', form), async () => {
          if (m) await setCustomerUser(m.user_id, { role: v.role, outletId: v.role === 'approver' ? null : (v.outletId || null), isActive: form.elements.isActive.checked });
          else {
            if (!v.fullName.trim() || !v.email.trim()) throw new Error('Name and email are required.');
            await inviteCustomerUser({ restaurantId: state.me.restaurant.id, email: v.email, fullName: v.fullName, phone: v.phone, role: v.role, outletId: v.role === 'approver' ? null : (v.outletId || null) });
          }
        });
        toast(m ? 'Member updated' : `Invitation sent to ${v.email}`, 'success'); close(); await renderOrganisation(container, state);
      } catch (error) { $('#member-error', el).textContent = error.message; }
    };
  }

  on(container, 'click', '#add-outlet', () => outletForm());
  on(container, 'click', '[data-edit-outlet]', (_e, b) => outletForm(outlets.find((o) => o.id === b.dataset.editOutlet)));
  on(container, 'click', '#invite-member', () => memberForm());
  on(container, 'click', '[data-edit-member]', (_e, b) => memberForm(members.find((m) => m.user_id === b.dataset.editMember)));
}
