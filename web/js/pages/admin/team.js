// =============================================================================
// team.js — everyone with an account: app role, team role, city / warehouse
// scope, active flag. New ADMIN or DELIVERY staff are invited from this page:
// the invite-staff Edge Function emails them a link, they choose a password,
// and sign in on their role's login page. Sign-up on the public page can only
// ever create a customer. See docs/runbook.md and docs/roles.md.
//
// What a team role may do is set on Settings → Roles & permissions.
// Scope: a city or warehouse here limits WHICH rows the person sees.
// =============================================================================

import { html, mount, on, $, formatDate, reportError, toast, withBusy } from '../../core/ui.js';
import { listUsers, setTeamMember, inviteStaff, listTeamRoles, listCities, listWarehouses } from '../../core/api.js';
import { can } from '../../core/permissions.js';

const ROLES = ['admin', 'restaurant', 'delivery'];

export async function renderTeam(container, me) {
  const editable = can(me, 'team', 'edit');
  const superAdmin = me.profile.team_role === 'super_admin';
  const [users, teamRoles, cities, warehouses] = await Promise.all([listUsers(), listTeamRoles(), listCities(), listWarehouses()]);
  const staffRoles = teamRoles.filter((r) => r.code !== 'driver');
  const cityName = Object.fromEntries(cities.map((c) => [c.id, c.name]));

  const teamRoleOptions = (current) => staffRoles.map((r) =>
    html`<option value="${r.code}" ${r.code === current ? 'selected' : ''} ${r.code === 'super_admin' && !superAdmin ? 'disabled' : ''}>${r.name}</option>`);

  mount(container, html`
    <div class="page-head"><div><h1>Team &amp; users</h1><p>${users.length} accounts · roles are defined under <a href="#roles">Settings → Roles</a></p></div></div>
    ${editable ? html`<form class="card card-pad" id="invite-form" novalidate style="margin-bottom:var(--space-5)">
      <h2 style="margin-bottom:var(--space-3)">Invite a team member</h2>
      <div class="row-wrap" style="align-items:flex-end">
        <label class="field grow"><span class="label">Email</span><input class="input" name="email" type="email" required placeholder="name@example.com"></label>
        <label class="field grow"><span class="label">Name (optional)</span><input class="input" name="fullName" maxlength="120"></label>
        <label class="field"><span class="label">App</span><select class="select" name="role">
          <option value="admin">Admin app</option><option value="delivery">Delivery app</option></select></label>
        <label class="field"><span class="label">Team role</span><select class="select" name="teamRole">${teamRoleOptions('support')}</select></label>
        <button class="btn primary" type="submit">Send invite</button>
      </div>
      <p class="muted small" style="margin-top:var(--space-2)">They receive an email link, choose a password, and sign in at their app's login page. Set their city / warehouse below once they appear.</p>
      <p class="form-error" id="invite-error" role="alert"></p>
    </form>` : ''}
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>User</th><th>App</th><th>Team role</th><th>City</th><th>Warehouse</th><th>Active</th><th>Joined</th><th></th></tr></thead>
      <tbody>${users.map((u) => {
        const self = u.id === me.user.id;
        const locked = self || !editable;
        const isStaff = u.role !== 'restaurant';
        return html`<tr data-row="${u.id}">
          <td><strong>${u.full_name || u.email}</strong><div class="muted small">${u.email}${u.restaurant_name ? ` · ${u.restaurant_name}` : ''}</div></td>
          <td><select class="select small" data-role ${locked ? 'disabled' : ''} aria-label="App">
            ${ROLES.map((r) => html`<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`)}</select></td>
          <td>${isStaff ? html`<select class="select small" data-team-role ${locked || u.role === 'delivery' ? 'disabled' : ''} aria-label="Team role">
            ${u.role === 'delivery' ? html`<option value="driver" selected>Driver</option>` : teamRoleOptions(u.team_role)}</select>` : html`<span class="muted small">Customer</span>`}</td>
          <td>${isStaff ? html`<select class="select small" data-city ${locked ? 'disabled' : ''} aria-label="City scope">
            <option value="">All cities</option>${cities.map((c) => html`<option value="${c.id}" ${c.id === u.city_id ? 'selected' : ''}>${c.name}</option>`)}</select>` : ''}</td>
          <td>${isStaff ? html`<select class="select small" data-warehouse ${locked ? 'disabled' : ''} aria-label="Warehouse scope">
            <option value="">All warehouses</option>${warehouses.map((w) => html`<option value="${w.id}" data-city="${w.city_id}" ${w.id === u.warehouse_id ? 'selected' : ''}>${w.name} (${cityName[w.city_id] ?? ''})</option>`)}</select>` : ''}</td>
          <td><label class="check"><input type="checkbox" data-active ${u.is_active ? 'checked' : ''} ${locked ? 'disabled' : ''}> <span class="small">Active</span></label></td>
          <td class="muted nowrap">${formatDate(u.created_at)}</td>
          <td class="right">${self ? html`<span class="muted small">You</span>` : editable ? html`<button class="btn small" data-save>Save</button>` : ''}</td></tr>`;
      })}</tbody></table></div></div>`);

  on(container, 'submit', '#invite-form', async (event, form) => {
    event.preventDefault();
    const error = $('#invite-error', container);
    error.textContent = '';
    if (!form.checkValidity()) { error.textContent = 'Enter a valid email address.'; return; }
    const v = Object.fromEntries(new FormData(form));
    try {
      await withBusy($('button[type="submit"]', form), () => inviteStaff({ email: v.email, role: v.role, fullName: v.fullName, teamRole: v.role === 'delivery' ? 'driver' : v.teamRole }));
      toast(`Invite sent to ${v.email}`, 'success');
      renderTeam(container, me);
    } catch (err) { error.textContent = err.message; }
  });

  on(container, 'click', '[data-save]', async (_e, button) => {
    const row = button.closest('tr');
    const role = $('[data-role]', row).value;
    try {
      await withBusy(button, () => setTeamMember(row.dataset.row, {
        role,
        isActive: $('[data-active]', row).checked,
        teamRole: role === 'restaurant' ? null : $('[data-team-role]', row)?.value,
        cityId: $('[data-city]', row)?.value,
        warehouseId: $('[data-warehouse]', row)?.value,
      }));
      toast('User updated', 'success');
    } catch (error) { reportError(error); }
  });
}
