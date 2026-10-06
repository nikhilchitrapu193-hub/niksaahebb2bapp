// =============================================================================
// team.js — everyone with an account: change roles, deactivate users.
//
// New ADMIN or DELIVERY staff are invited from this page: the invite-staff
// Edge Function emails them a link, they choose a password, and sign in on
// their role's login page. Sign-up on the public page can only ever create a
// restaurant. See docs/runbook.md.
// =============================================================================

import { html, mount, on, $, formatDate, reportError, toast, withBusy } from '../../core/ui.js';
import { listUsers, setUserRole, inviteStaff } from '../../core/api.js';

const ROLES = ['admin', 'restaurant', 'delivery'];

export async function renderTeam(container, me) {
  const users = await listUsers();

  mount(container, html`
    <div class="page-head"><div><h1>Team &amp; users</h1><p>${users.length} accounts</p></div></div>
    <form class="card card-pad" id="invite-form" novalidate style="margin-bottom:var(--space-5)">
      <h2 style="margin-bottom:var(--space-3)">Invite a team member</h2>
      <div class="row-wrap" style="align-items:flex-end">
        <label class="field grow"><span class="label">Email</span><input class="input" name="email" type="email" required placeholder="name@example.com"></label>
        <label class="field grow"><span class="label">Name (optional)</span><input class="input" name="fullName" maxlength="120"></label>
        <label class="field"><span class="label">Role</span><select class="select" name="role">
          <option value="delivery">Delivery staff</option><option value="admin">Admin</option></select></label>
        <button class="btn primary" type="submit">Send invite</button>
      </div>
      <p class="muted small" style="margin-top:var(--space-2)">They receive an email link, choose a password, and sign in at their role's login page.</p>
      <p class="form-error" id="invite-error" role="alert"></p>
    </form>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>User</th><th>Role</th><th>Active</th><th>Joined</th><th></th></tr></thead>
      <tbody>${users.map((u) => {
        const self = u.id === me.user.id;
        return html`<tr data-row="${u.id}">
          <td><strong>${u.full_name || u.email}</strong><div class="muted small">${u.email}${u.restaurant_name ? ` · ${u.restaurant_name}` : ''}</div></td>
          <td><select class="select small" data-role ${self ? 'disabled' : ''} aria-label="Role">
            ${ROLES.map((r) => html`<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`)}</select></td>
          <td><label class="check"><input type="checkbox" data-active ${u.is_active ? 'checked' : ''} ${self ? 'disabled' : ''}> <span class="small">Active</span></label></td>
          <td class="muted nowrap">${formatDate(u.created_at)}</td>
          <td class="right">${self ? html`<span class="muted small">You</span>` : html`<button class="btn small" data-save>Save</button>`}</td></tr>`;
      })}</tbody></table></div></div>`);

  on(container, 'submit', '#invite-form', async (event, form) => {
    event.preventDefault();
    const error = $('#invite-error', container);
    error.textContent = '';
    if (!form.checkValidity()) { error.textContent = 'Enter a valid email address.'; return; }
    const v = Object.fromEntries(new FormData(form));
    try {
      await withBusy($('button[type="submit"]', form), () => inviteStaff({ email: v.email, role: v.role, fullName: v.fullName }));
      toast(`Invite sent to ${v.email}`, 'success');
      renderTeam(container, me);
    } catch (err) { error.textContent = err.message; }
  });

  container.querySelectorAll('[data-save]').forEach((button) => {
    button.onclick = async () => {
      const row = button.closest('tr');
      try {
        await setUserRole(row.dataset.row, row.querySelector('[data-role]').value, row.querySelector('[data-active]').checked);
        toast('User updated', 'success');
      } catch (error) { reportError(error); }
    };
  });
}
