// =============================================================================
// customers.js — restaurants: approve new sign-ups, suspend or reinstate.
// =============================================================================

import { html, mount, formatDate, formatINR, statusBadge, reportError, toast, confirmDialog } from '../../core/ui.js';
import { listRestaurants, setRestaurantStatus, listOutstandingBalances } from '../../core/api.js';

export async function renderCustomers(container, onPendingChange) {
  const [restaurants, balances] = await Promise.all([listRestaurants(), listOutstandingBalances()]);
  const owed = Object.fromEntries(balances.map((b) => [b.restaurant_id, b]));
  const pending = restaurants.filter((r) => r.status === 'pending').length;
  onPendingChange?.(pending);

  mount(container, html`
    <div class="page-head"><div><h1>Customers</h1><p>${restaurants.length} restaurants · ${pending} awaiting approval</p></div></div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Restaurant</th><th>Contact</th><th class="right">Outstanding</th><th>Joined</th><th>Status</th><th></th></tr></thead>
      <tbody>${restaurants.length === 0
        ? html`<tr><td colspan="6"><div class="empty">No restaurants have registered yet.</div></td></tr>`
        : restaurants.map((r) => html`<tr>
          <td><strong>${r.name}</strong><div class="muted small">${r.address || ''}</div>${r.gstin ? html`<div class="muted tiny">GSTIN ${r.gstin}</div>` : ''}${r.fssai ? html`<div class="muted tiny">FSSAI ${r.fssai}</div>` : html`<div class="tiny" style="color:var(--accent)">No FSSAI number</div>`}</td>
          <td>${r.phone || '—'}</td>
          <td class="right num">${owed[r.id] ? html`<strong>${formatINR(owed[r.id].outstanding)}</strong><div class="muted tiny">${owed[r.id].unpaid_orders} unpaid</div>` : html`<span class="muted">—</span>`}</td><td class="nowrap muted">${formatDate(r.created_at)}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="right nowrap">
            ${r.status !== 'approved' ? html`<button class="btn primary small" data-set="approved" data-id="${r.id}">Approve</button>` : ''}
            ${r.status === 'approved' ? html`<button class="btn danger small" data-set="suspended" data-id="${r.id}">Suspend</button>` : ''}
          </td></tr>`)}
      </tbody></table></div></div>`);

  container.querySelectorAll('[data-set]').forEach((button) => {
    button.onclick = async () => {
      const status = button.dataset.set;
      if (status === 'suspended' && !(await confirmDialog('Suspend this restaurant? They will not be able to place orders.', { confirmText: 'Suspend', danger: true }))) return;
      try {
        await setRestaurantStatus(button.dataset.id, status);
        toast(`Restaurant ${status}`, 'success');
        renderCustomers(container, onPendingChange);
      } catch (error) { reportError(error); }
    };
  });
}
