// =============================================================================
// audit.js — who changed what and when: prices, orders, payments, customers,
// team members, permissions and settings (audit_log, migration 006).
// Filter by table or by person; export the current view as CSV.
// Stock changes are not here: Inventory → Ledger is their own history.
// =============================================================================

import { html, mount, on, $, formatDateTime, reportError } from '../../core/ui.js';
import { listAuditLog, listUsers } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';

const TABLE_LABELS = {
  products: 'Products', orders: 'Orders', restaurants: 'Customers', profiles: 'Team / users',
  role_permissions: 'Permissions', sectors: 'Sectors', cities: 'Cities', warehouses: 'Warehouses',
  service_zones: 'Pin codes', company_settings: 'Company settings',
};

/** "price: 32 → 33" lines for an update; a short "created"/"deleted" otherwise. */
export function describeChanges(entry) {
  if (entry.action !== 'update') return [{ key: entry.action === 'insert' ? 'created' : 'deleted', old: null, new: null }];
  return Object.entries(entry.changes).map(([key, v]) => ({ key, old: show(v.old), new: show(v.new) }));
}
function show(value) {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export async function renderAudit(container, me) {
  let table = '';
  let userId = '';
  const users = can(me, 'team', 'view') ? await listUsers().catch(() => []) : [];
  const nameOf = Object.fromEntries(users.map((u) => [u.id, u.full_name || u.email]));
  let entries = [];

  async function draw() {
    entries = await listAuditLog({ table: table || undefined, userId: userId || undefined });
    mount(container, html`
      <div class="page-head"><div><h1>Audit log</h1><p>Latest ${entries.length} changes${table ? ` in ${TABLE_LABELS[table] ?? table}` : ''}</p></div>
        ${can(me, 'audit', 'export') ? html`<button class="btn" id="export">Export CSV</button>` : ''}</div>
      <div class="toolbar">
        <select class="select" id="table-filter" aria-label="Filter by table">
          <option value="">All tables</option>
          ${Object.entries(TABLE_LABELS).map(([k, label]) => html`<option value="${k}" ${k === table ? 'selected' : ''}>${label}</option>`)}
        </select>
        ${users.length ? html`<select class="select" id="user-filter" aria-label="Filter by person">
          <option value="">Everyone</option>
          ${users.map((u) => html`<option value="${u.id}" ${u.id === userId ? 'selected' : ''}>${u.full_name || u.email}</option>`)}
        </select>` : ''}
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>Who</th><th>Table</th><th>Record</th><th>Change</th></tr></thead>
        <tbody>${entries.length === 0 ? html`<tr><td colspan="5"><div class="empty">No changes recorded yet.</div></td></tr>`
          : entries.map((e) => html`<tr>
            <td class="nowrap muted small">${formatDateTime(e.changed_at)}</td>
            <td class="small">${nameOf[e.changed_by] ?? (e.changed_by ? e.changed_by.slice(0, 8) : 'system')}</td>
            <td class="small">${TABLE_LABELS[e.table_name] ?? e.table_name}</td>
            <td class="tiny muted">${e.row_id.slice(0, 8)}</td>
            <td><ul class="diff">${describeChanges(e).map((c) => html`<li><strong>${c.key}</strong>${c.old === null ? '' : html`: <span class="old">${c.old}</span> <span class="new">${c.new}</span>`}</li>`)}</ul></td>
          </tr>`)}
        </tbody></table></div></div>`);
  }

  on(container, 'change', '#table-filter', (_e, el) => { table = el.value; draw().catch(reportError); });
  on(container, 'change', '#user-filter', (_e, el) => { userId = el.value; draw().catch(reportError); });
  on(container, 'click', '#export', () => downloadCsv('audit-log.csv', entries, [
    { key: 'changed_at', label: 'When' },
    { label: 'Who', value: (e) => nameOf[e.changed_by] ?? e.changed_by ?? 'system' },
    { key: 'table_name', label: 'Table' },
    { key: 'row_id', label: 'Record' },
    { key: 'action', label: 'Action' },
    { label: 'Changes', value: (e) => describeChanges(e).map((c) => c.old === null ? c.key : `${c.key}: ${c.old} -> ${c.new}`).join('; ') },
  ]));

  await draw();
}
