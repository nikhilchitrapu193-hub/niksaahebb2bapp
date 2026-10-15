// =============================================================================
// roles.js — the permission matrix: one table per team role, modules down the
// side, actions across the top, a tick box in every cell. Super admin has
// every permission and is not editable. Only a super admin may change ticks
// (RLS on role_permissions); other team members can look.
//
// A change takes effect the next time the affected person loads the app.
// =============================================================================

import { html, mount, on, reportError, toast } from '../../core/ui.js';
import { listTeamRoles, listRolePermissions, setRolePermission } from '../../core/api.js';
import { MODULES, ACTIONS } from '../../core/config.js';
import { settingsTabs } from './settings.js';

export async function renderRoles(container, me) {
  const editable = me.profile.team_role === 'super_admin';
  const [roles, rows] = await Promise.all([listTeamRoles(), listRolePermissions()]);
  const allowed = new Set(rows.map((r) => `${r.team_role}:${r.module}:${r.action}`));
  let selected = roles.find((r) => r.code !== 'super_admin')?.code ?? '';

  function draw() {
    const role = roles.find((r) => r.code === selected);
    const fixed = role?.code === 'super_admin' || role?.code === 'driver';
    mount(container, html`
      <div class="page-head"><div><h1>Roles &amp; permissions</h1><p>What each team role may do in the admin app. Scope (city / warehouse) is set per person on the Team screen.</p></div></div>
      ${settingsTabs(me, '#roles')}
      <div class="toolbar">
        <label class="field"><span class="label">Team role</span>
          <select class="select" id="role-select">${roles.map((r) => html`<option value="${r.code}" ${r.code === selected ? 'selected' : ''}>${r.name}</option>`)}</select></label>
        <p class="muted small grow">${role?.description ?? ''}</p>
      </div>
      ${fixed ? html`<div class="banner info">${role.code === 'super_admin' ? 'Super admin can do everything; this cannot be changed.' : 'Drivers use the delivery app and have no admin-app permissions.'}</div>` : ''}
      ${!editable && !fixed ? html`<div class="banner warn">Only a super admin can change these ticks.</div>` : ''}
      <div class="card"><div class="table-wrap"><table class="table matrix">
        <thead><tr><th>Module</th>${Object.values(ACTIONS).map((label) => html`<th>${label}</th>`)}</tr></thead>
        <tbody>${Object.entries(MODULES).map(([module, m]) => html`<tr>
          <td><strong>${m.label}</strong></td>
          ${Object.keys(ACTIONS).map((action) => {
            const on = role?.code === 'super_admin' || allowed.has(`${selected}:${module}:${action}`);
            return html`<td><input type="checkbox" data-module="${module}" data-action="${action}" ${on ? 'checked' : ''} ${editable && !fixed ? '' : 'disabled'} aria-label="${m.label}: ${ACTIONS[action]}"></td>`;
          })}</tr>`)}
        </tbody></table></div></div>`);
  }

  on(container, 'change', '#role-select', (_e, el) => { selected = el.value; draw(); });
  on(container, 'change', 'input[data-module]', async (_e, box) => {
    const key = `${selected}:${box.dataset.module}:${box.dataset.action}`;
    try {
      await setRolePermission(selected, box.dataset.module, box.dataset.action, box.checked);
      if (box.checked) allowed.add(key); else allowed.delete(key);
      toast('Permission saved', 'success');
    } catch (error) { box.checked = !box.checked; reportError(error); }
  });

  draw();
}
