// =============================================================================
// customers.js — customer accounts of every sector: approve new sign-ups,
// suspend or reinstate, set sector / city / warehouse / pin code and the
// per-customer overrides of the sector terms (MOV, delivery fee, credit days,
// credit limit). The Outstanding column is the open-item position from
// migration 015; the full ledger is under Payments.
//
// Login state (migration 016): the Login column shows the customer's email and
// whether it is confirmed. "Access" opens the backups for a customer who is
// stuck at the email step: confirm the email now, resend the confirmation, get
// a one-time password link to send on WhatsApp, or set a temporary password.
// These go through the customer-access Edge Function (customers:approve).
//
// A customer can only be approved once a warehouse serves them (from their
// pin code, or set here); the database refuses otherwise (set_customer_status).
// =============================================================================

import { html, mount, on, $, formatDate, formatDateTime, formatINR, statusBadge, reportError, toast, confirmDialog, openModal, withBusy } from '../../core/ui.js';
import { listRestaurants, setRestaurantStatus, listOutstandingBalances, saveCustomerTerms, listSectors, listCities, listWarehouses,
         listCustomerLogins, customerAccess, uploadCustomerDocument, customerDocumentUrl, listOutlets, listCustomerUsersOf, setCustomerUser,
         inviteCustomerUser, saveOutlet } from '../../core/api.js';
import { CUSTOMER_DOCUMENTS, CUSTOMER_ROLES, DELIVERY_SLOTS } from '../../core/config.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';
import { contactLinks, mapHref } from '../../core/notify.js';
import { config } from '../../core/config.js';

export async function renderCustomers(container, me, onPendingChange) {
  const [restaurants, balances, sectors, cities, warehouses, logins] = await Promise.all([
    listRestaurants(), listOutstandingBalances(), listSectors(), listCities(), listWarehouses(),
    listCustomerLogins().catch(() => []),   // migration 016; an older database just shows no login column
  ]);
  const owed = Object.fromEntries(balances.map((b) => [b.restaurant_id, b]));
  const login = Object.fromEntries(logins.map((l) => [l.restaurant_id, l]));
  const unconfirmed = logins.filter((l) => !l.email_confirmed).length;
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
    ${unconfirmed > 0 ? html`<div class="banner warn" id="unconfirmed-banner">${unconfirmed} customer${unconfirmed === 1 ? '' : 's'} cannot sign in yet: their confirmation email was not used.
      ${canApprove ? 'Open Access on the row to confirm the email for them, resend it, or send a sign-in link.' : 'A team member with customers: approve can fix this under Access.'}</div>` : ''}
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Customer</th><th>Sector · city</th><th>Contact</th><th>Login</th><th class="right">Outstanding</th><th>Joined</th><th>Status</th><th></th></tr></thead>
      <tbody>${restaurants.length === 0
        ? html`<tr><td colspan="8"><div class="empty">No customers have registered yet.</div></td></tr>`
        : restaurants.map((r) => html`<tr data-row="${r.id}">
          <td><strong>${r.name}</strong><div class="muted small">${r.address || ''}${r.pincode ? ` · ${r.pincode}` : ''}</div>
            ${r.gstin ? html`<div class="muted tiny">GSTIN ${r.gstin}</div>` : ''}
            ${r.fssai ? html`<div class="muted tiny">FSSAI ${r.fssai}</div>` : html`<div class="tiny" style="color:var(--accent)">No FSSAI number</div>`}
            <div class="row tiny" style="gap:8px">${Object.entries(CUSTOMER_DOCUMENTS).map(([kind, d]) => r[d.column]
              ? html`<a href="#" data-view-doc="${kind}" data-id="${r.id}" title="${d.label} on file">${d.label} ✓</a>`
              : html`<span class="muted">${d.label} —</span>`)}
              ${canEdit ? html`<label style="cursor:pointer;color:var(--brand)">upload<input type="file" hidden data-upload-doc="${r.id}" accept="application/pdf,image/jpeg,image/png,image/webp"></label>` : ''}</div></td>
          <td class="small">${sectorName[r.sector_code] ?? r.sector_code}${sectors.find((s) => s.code === r.sector_code)?.is_active === false ? html` <span class="badge inactive">sector off</span>` : ''}<div class="muted tiny">${cityName[r.city_id] ?? '—'} · ${r.warehouse_id ? warehouseName[r.warehouse_id] : html`<span style="color:var(--danger)">no warehouse</span>`}</div></td>
          <td>${r.phone || '—'}${contactLinks(r.phone, `Hello ${r.name}, this is ${config.appName}`)}${mapHref(r.lat, r.lng, r.address) ? html`<div class="tiny"><a href="${mapHref(r.lat, r.lng, r.address)}" target="_blank" rel="noopener">${r.lat != null ? 'Map pin' : 'Find on map'}</a></div>` : ''}</td>
          <td class="small">${login[r.id] ? html`${login[r.id].email}<div class="tiny">${login[r.id].email_confirmed
              ? html`<span class="muted">confirmed${login[r.id].last_sign_in_at ? ` · last sign-in ${formatDate(login[r.id].last_sign_in_at)}` : ' · never signed in'}</span>`
              : html`<span style="color:var(--danger)">email not confirmed — cannot sign in</span>`}</div>` : html`<span class="muted">—</span>`}</td>
          <td class="right num">${owed[r.id] ? html`<a href="#payments" title="Open receivables"><strong>${formatINR(owed[r.id].outstanding)}</strong></a><div class="muted tiny">${owed[r.id].unpaid_orders} open</div>` : html`<span class="muted">—</span>`}</td>
          <td class="nowrap muted">${formatDate(r.created_at)}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="right nowrap">
            ${canApprove && login[r.id] ? html`<button class="btn small ${login[r.id].email_confirmed ? '' : 'primary'}" data-access="${r.id}">Access</button>` : ''}
            <button class="btn small" data-account="${r.id}">Account</button>
            ${canEdit ? html`<button class="btn small" data-terms="${r.id}">Terms</button>` : ''}
            ${canApprove && r.status !== 'approved' ? html`<button class="btn primary small" data-set="approved" data-id="${r.id}">Approve</button>` : ''}
            ${canApprove && r.status === 'approved' ? html`<button class="btn danger small" data-set="suspended" data-id="${r.id}">Suspend</button>` : ''}
          </td></tr>`)}
      </tbody></table></div></div>`);

  const refresh = () => renderCustomers(container, me, onPendingChange);

  // Account (migration 020): the customer's outlets and members; staff with customers:edit add outlets / invite members.
  on(container, 'click', '[data-account]', (_e, b) => accountDialog(restaurants.find((r) => r.id === b.dataset.account), { cities, warehouses, canEdit }));

  // Documents (migration 019): view opens a short-lived signed link; upload asks which document it is.
  on(container, 'click', '[data-view-doc]', async (event, link) => {
    event.preventDefault();
    const r = restaurants.find((x) => x.id === link.dataset.id);
    try { window.open(await customerDocumentUrl(r[CUSTOMER_DOCUMENTS[link.dataset.viewDoc].column]), '_blank', 'noopener'); } catch (error) { reportError(error); }
  });
  on(container, 'change', '[data-upload-doc]', async (_e, input) => {
    const file = input.files?.[0];
    if (!file) return;
    const kind = /gst/i.test(file.name) ? 'gst' : 'fssai';
    const which = window.prompt('Which document is this? Type fssai or gst', kind);
    if (!which || !CUSTOMER_DOCUMENTS[which.trim().toLowerCase()]) return;
    try { await uploadCustomerDocument(input.dataset.uploadDoc, which.trim().toLowerCase(), file); toast('Document uploaded', 'success'); refresh(); }
    catch (error) { reportError(error); }
  });

  on(container, 'click', '[data-set]', async (_e, button) => {
    const status = button.dataset.set;
    if (status === 'suspended' && !(await confirmDialog('Suspend this customer? They will not be able to place orders.', { confirmText: 'Suspend', danger: true }))) return;
    try {
      await setRestaurantStatus(button.dataset.id, status);
      const l = login[button.dataset.id];
      toast(status === 'approved' && l && !l.email_confirmed
        ? 'Customer approved — but their email is not confirmed, so they still cannot sign in. Use Access.'
        : `Customer ${status}`, status === 'approved' && l && !l.email_confirmed ? 'info' : 'success');
      refresh();
    } catch (error) { reportError(error); }
  });

  on(container, 'click', '[data-terms]', (_e, button) =>
    termsForm(restaurants.find((r) => r.id === button.dataset.terms), { sectors, cities, warehouses }, refresh));
  on(container, 'click', '[data-access]', (_e, button) =>
    accessDialog(restaurants.find((r) => r.id === button.dataset.access), login[button.dataset.access], refresh));

  on(container, 'click', '#export', () => downloadCsv('customers.csv', restaurants, [
    { key: 'name', label: 'Customer' },
    { label: 'Sector', value: (r) => sectorName[r.sector_code] ?? r.sector_code },
    { label: 'City', value: (r) => cityName[r.city_id] ?? '' },
    { label: 'Warehouse', value: (r) => warehouseName[r.warehouse_id] ?? '' },
    { key: 'pincode', label: 'Pin code' },
    { key: 'phone', label: 'Phone' },
    { label: 'Email', value: (r) => login[r.id]?.email ?? '' },
    { label: 'Email confirmed', value: (r) => (login[r.id] ? (login[r.id].email_confirmed ? 'yes' : 'no') : '') },
    { key: 'gstin', label: 'GSTIN' },
    { key: 'fssai', label: 'FSSAI' },
    { key: 'status', label: 'Status' },
    { label: 'Credit limit', value: (r) => r.credit_limit ?? '' },
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
          ${sectors.map((s) => html`<option value="${s.code}" ${s.code === customer.sector_code ? 'selected' : ''}>${s.name}${s.is_active ? '' : ' (not live yet)'}</option>`)}</select></label>
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
        <label class="field"><span class="label">Credit limit (₹)</span><input class="input num" type="number" min="0" name="credit_limit" value="${customer.credit_limit ?? ''}" placeholder="${initial.credit_limit ?? 'none'}"><span class="hint">Blank = the sector's limit; the sector's blank = no limit.</span></label>
        <label class="field"><span class="label">Approval before dispatch</span><select class="select" name="needs_order_approval">
          <option value="" ${customer.needs_order_approval == null ? 'selected' : ''}>Sector default (${initial.needs_order_approval ? 'required' : 'not required'})</option>
          <option value="true" ${customer.needs_order_approval === true ? 'selected' : ''}>Required — an owner / approver signs off orders placed by outlet managers</option>
          <option value="false" ${customer.needs_order_approval === false ? 'selected' : ''}>Not required</option></select></label>
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
    $('[name=credit_limit]', el).placeholder = s.credit_limit ?? 'none';
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

/**
 * The backups for a customer stuck at the email step. Every action goes to the
 * customer-access Edge Function, which re-checks customers:approve and scope.
 */
function accessDialog(customer, login, onChanged) {
  const { el, close } = openModal(html`<div id="access" class="stack"></div>`, { title: `Access: ${customer.name}`, wide: true });
  const host = $('#access', el);
  let state = { ...login };
  let note = null;     // { kind, text, link? } shown after an action

  function draw() {
    mount(host, html`
      <dl class="kv">
        <dt>Email</dt><dd>${state.email}</dd>
        <dt>Confirmed</dt><dd>${state.email_confirmed ? html`<span class="badge approved">Yes</span>` : html`<span class="badge pending">No — cannot sign in</span>${state.confirmation_sent_at ? html` <span class="muted small">confirmation sent ${formatDateTime(state.confirmation_sent_at)}</span>` : ''}`}</dd>
        <dt>Last sign-in</dt><dd>${state.last_sign_in_at ? formatDateTime(state.last_sign_in_at) : 'never'}</dd>
        <dt>Account</dt><dd>${statusBadge(customer.status)} <span class="muted small">approval is separate: approve on the Customers list</span></dd>
      </dl>
      ${note ? html`<div class="banner ${note.kind}">${note.text}${note.link ? html`<div style="margin-top:var(--space-2)"><input class="input" readonly value="${note.link}" id="access-link" style="width:100%">
        <div class="row" style="margin-top:var(--space-2)"><button class="btn small" data-copy>Copy link</button>
        <a class="btn small" target="_blank" rel="noopener" href="https://wa.me/${(customer.phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(`Hello ${customer.name}, set your Fresh Supply password here (one-time link, valid about an hour): ${note.link}`)}">Send on WhatsApp</a></div></div>` : ''}</div>` : ''}
      <div class="rule-grid">
        <div class="card card-pad stack-sm rule-card"><h3>Confirm email now</h3>
          <p class="muted small">You have spoken to them and know the address is right. They can sign in straight away with the password they chose.</p>
          <button class="btn primary" data-act="confirm_email" ${state.email_confirmed ? 'disabled' : ''}>${state.email_confirmed ? 'Already confirmed' : 'Confirm email'}</button></div>
        <div class="card card-pad stack-sm rule-card"><h3>Resend the email</h3>
          <p class="muted small">Sends the confirmation again (ask them to check spam). Supabase allows only a few emails an hour per address.</p>
          <button class="btn" data-act="resend_confirmation" ${state.email_confirmed ? 'disabled' : ''}>Resend confirmation</button></div>
        <div class="card card-pad stack-sm rule-card"><h3>Password link</h3>
          <p class="muted small">A one-time link to set a password, for WhatsApp or a phone call. Confirms the email too. Valid about an hour.</p>
          <button class="btn" data-act="password_link">Get link</button></div>
        <div class="card card-pad stack-sm rule-card"><h3>Temporary password</h3>
          <p class="muted small">Set a password and tell them over the phone; they can change it later under Forgot password.</p>
          <form id="set-pass" class="row"><input class="input" name="password" type="text" minlength="8" maxlength="72" placeholder="at least 8 characters" required style="flex:1"><button class="btn" type="submit">Set</button></form></div>
      </div>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div>`);
  }

  async function run(action, button, extra) {
    try {
      const r = await withBusy(button, () => customerAccess(action, customer.id, extra));
      if (action === 'confirm_email') { state.email_confirmed = true; note = { kind: 'info', text: `${state.email} is confirmed. ${customer.status === 'approved' ? 'They can sign in and order now.' : 'They can sign in; approve the account so they can order.'}` }; }
      if (action === 'resend_confirmation') note = { kind: 'info', text: `Confirmation email sent again to ${state.email}.` };
      if (action === 'password_link') { state.email_confirmed = true; note = { kind: 'info', text: 'One-time link ready. Send it to the customer; it opens the "choose a password" page.', link: r.link }; }
      if (action === 'set_password') { state.email_confirmed = true; note = { kind: 'info', text: `Temporary password set for ${state.email}. Tell them by phone; they can sign in now.` }; }
      draw(); onChanged?.();
    } catch (error) { note = { kind: 'error', text: error.message }; draw(); }
  }

  on(host, 'click', '[data-act]', (_e, b) => run(b.dataset.act, b));
  on(host, 'submit', '#set-pass', (event, form) => {
    event.preventDefault();
    if (!form.checkValidity()) { note = { kind: 'error', text: 'The temporary password needs at least 8 characters.' }; draw(); return; }
    run('set_password', $('button[type="submit"]', form), { password: form.elements.password.value });
  });
  on(host, 'click', '[data-copy]', async () => {
    try { await navigator.clipboard.writeText($('#access-link', host).value); toast('Link copied', 'success'); }
    catch { $('#access-link', host).select(); toast('Select the link and copy it', 'info'); }
  });
  draw();
}


/** Outlets and members of one customer account (migration 020). */
async function accountDialog(customer, { cities, warehouses, canEdit }) {
  const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`, { title: `Account: ${customer.name}`, wide: true });
  const cityName = Object.fromEntries(cities.map((c) => [c.id, c.name]));
  const warehouseName = Object.fromEntries(warehouses.map((w) => [w.id, w.name]));
  const draw = async () => {
    const [outlets, members] = await Promise.all([listOutlets(customer.id), listCustomerUsersOf(customer.id).catch(() => [])]);
    mount(el, html`<div class="stack">
      <div class="spread"><h3>Outlets</h3>${canEdit ? html`<button class="btn small" id="acc-add-outlet">Add an outlet</button>` : ''}</div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Outlet</th><th>Address</th><th>Warehouse</th><th>Slot</th></tr></thead>
        <tbody>${outlets.map((o) => html`<tr><td><strong>${o.name}</strong>${o.is_primary ? html` <span class="badge confirmed">primary</span>` : ''}${o.is_active ? '' : html` <span class="badge inactive">off</span>`}</td>
          <td class="small">${o.address}<div class="muted tiny">${cityName[o.city_id] ?? ''}${o.pincode ? ` · ${o.pincode}` : ''}</div></td>
          <td class="small">${o.warehouse_id ? warehouseName[o.warehouse_id] : html`<span style="color:var(--danger)">none</span>`}</td>
          <td class="small">${DELIVERY_SLOTS[o.default_slot]?.label ?? o.default_slot}</td></tr>`)}</tbody></table></div>
      <div class="spread"><h3>People who sign in</h3>${canEdit ? html`<button class="btn small" id="acc-invite">Invite a member</button>` : ''}</div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Role</th><th>Outlet</th><th>Active</th><th></th></tr></thead>
        <tbody>${members.length === 0 ? html`<tr><td colspan="5" class="muted small">No members listed.</td></tr>` : members.map((m) => html`<tr>
          <td>${m.full_name || '—'}${m.phone ? html`<div class="muted tiny">${m.phone}</div>` : ''}</td>
          <td>${CUSTOMER_ROLES[m.role]?.label ?? m.role}</td>
          <td class="small">${m.role === 'outlet_manager' ? (m.outlet_name ?? 'All outlets') : 'All outlets'}</td>
          <td>${m.is_active ? 'yes' : html`<span class="muted">no</span>`}</td>
          <td class="right">${canEdit && m.role !== 'owner' ? html`<button class="btn ghost small" data-toggle-member="${m.user_id}" data-active="${m.is_active}">${m.is_active ? 'Disable' : 'Enable'}</button>` : ''}</td></tr>`)}</tbody></table></div>
      <p class="muted small">Approval before dispatch: <strong>${customer.needs_order_approval == null ? 'sector default' : customer.needs_order_approval ? 'required' : 'not required'}</strong> (change under Terms).</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div></div>`);
    el.querySelector('#acc-add-outlet')?.addEventListener('click', () => {
      const name = window.prompt('Outlet name'); if (!name) return;
      const address = window.prompt('Delivery address'); if (!address) return;
      const pincode = window.prompt('Pin code (6 digits, blank to skip)') || null;
      saveOutlet({ restaurantId: customer.id, name, address, pincode, cityId: customer.city_id }).then(() => { toast('Outlet added', 'success'); return draw(); }).catch(reportError);
    });
    el.querySelector('#acc-invite')?.addEventListener('click', () => {
      const email = window.prompt('Email address to invite'); if (!email) return;
      const fullName = window.prompt('Their name') || '';
      const role = /^a/i.test(window.prompt('Role: outlet manager or approver?', 'outlet manager') ?? '') ? 'approver' : 'outlet_manager';
      inviteCustomerUser({ restaurantId: customer.id, email, fullName, role }).then(() => { toast(`Invitation sent to ${email}`, 'success'); return draw(); }).catch(reportError);
    });
    el.querySelectorAll('[data-toggle-member]').forEach((b) => b.addEventListener('click', () => {
      setCustomerUser(b.dataset.toggleMember, { isActive: b.dataset.active !== 'true' }).then(draw).catch(reportError);
    }));
  };
  try { await draw(); } catch (error) { close(); reportError(error); }
}
