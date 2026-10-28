// =============================================================================
// sectors.js — customer types (restaurants, hotels, institutions, defence,
// retail) and the trading terms each one gets by default: minimum order value,
// delivery fee below it, credit days, credit limit (blank = none), whether an
// overdue invoice blocks pay-later orders, how many minutes after placing the
// customer may still edit or cancel (migration 017, 0 = no self-edit),
// PO number required, approval required, self sign-up allowed. A customer row
// can override MOV / fee / credit days / credit limit (Customers screen). The
// rules are enforced by place_order() / edit_order() / cancel_order() in the
// database. Switching a sector live / off is on Settings → Launch (the Active
// tick here is the same switch).
// =============================================================================

import { html, mount, on, $, formatINR, reportError, toast, withBusy } from '../../core/ui.js';
import { listSectors, saveSectorTerms } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { settingsTabs } from './settings.js';

export async function renderSectors(container, me) {
  const editable = can(me, 'settings', 'edit');
  const sectors = await listSectors();

  mount(container, html`
    <div class="page-head"><div><h1>Sectors &amp; terms</h1><p>Who you sell to, and the default terms for each type of customer.</p></div></div>
    ${settingsTabs(me, '#sectors')}
    <div class="banner info">Below the minimum order value a customer pays the delivery fee; if the fee is ₹0 the order is refused instead.</div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Sector</th><th class="right">Min. order (₹)</th><th class="right">Fee below min. (₹)</th><th class="right">Credit days</th><th class="right">Credit limit (₹)</th><th>Block credit when overdue</th><th class="right">Edit window (min)</th><th>PO required</th><th>Approval</th><th>Self sign-up</th><th>Active (live)</th><th></th></tr></thead>
      <tbody>${sectors.map((s) => html`<tr data-code="${s.code}">
        <td><strong>${s.name}</strong><div class="muted tiny">${s.description}</div></td>
        <td class="right"><input class="input small num right" type="number" min="0" step="1" name="min_order_value" value="${Number(s.min_order_value)}" style="width:100px" ${editable ? '' : 'disabled'}></td>
        <td class="right"><input class="input small num right" type="number" min="0" step="1" name="delivery_fee_below_mov" value="${Number(s.delivery_fee_below_mov)}" style="width:100px" ${editable ? '' : 'disabled'}></td>
        <td class="right"><input class="input small num right" type="number" min="0" max="365" step="1" name="credit_days" value="${s.credit_days}" style="width:80px" ${editable ? '' : 'disabled'}></td>
        <td class="right"><input class="input small num right" type="number" min="0" step="1" name="credit_limit" value="${s.credit_limit ?? ''}" placeholder="none" style="width:110px" ${editable ? '' : 'disabled'} aria-label="Credit limit for ${s.name}"></td>
        <td><input type="checkbox" name="block_credit_when_overdue" ${s.block_credit_when_overdue !== false ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="Block credit when overdue for ${s.name}"></td>
        <td class="right"><input class="input small num right" type="number" min="0" max="1440" step="1" name="customer_edit_window_minutes" value="${s.customer_edit_window_minutes ?? 15}" style="width:90px" ${editable ? '' : 'disabled'} aria-label="Edit window for ${s.name} in minutes"></td>
        <td><input type="checkbox" name="needs_po_reference" ${s.needs_po_reference ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="PO required for ${s.name}"></td>
        <td><input type="checkbox" name="needs_order_approval" ${s.needs_order_approval ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="Approval required for ${s.name}"></td>
        <td><input type="checkbox" name="can_self_register" ${s.can_self_register ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="Self sign-up for ${s.name}"></td>
        <td><input type="checkbox" name="is_active" ${s.is_active ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="${s.name} active"></td>
        <td class="right">${editable ? html`<button class="btn small" data-save>Save</button>` : ''}</td></tr>`)}
      </tbody></table></div></div>
    <p class="muted small" style="margin-top:var(--space-3)">Example: a restaurant ordering ${formatINR(1500)} with minimum ${formatINR(2000)} and fee ${formatINR(99)} pays ${formatINR(1599)} plus GST.
      A credit limit caps what a customer may owe (open invoices plus pay-later orders on the way); blank = no limit. Receivables are under <a href="#payments">Payments</a>.
      Edit window: how long after placing the customer themselves may change or cancel their order; 0 means a mistake becomes a phone call.</p>`);

  on(container, 'click', '[data-save]', async (_e, button) => {
    const row = button.closest('tr');
    const read = (name) => $(`[name="${name}"]`, row);
    try {
      await withBusy(button, () => saveSectorTerms(row.dataset.code, {
        min_order_value: read('min_order_value').value,
        delivery_fee_below_mov: read('delivery_fee_below_mov').value,
        credit_days: read('credit_days').value,
        credit_limit: read('credit_limit').value,
        block_credit_when_overdue: read('block_credit_when_overdue').checked,
        customer_edit_window_minutes: read('customer_edit_window_minutes').value,
        needs_po_reference: read('needs_po_reference').checked,
        needs_order_approval: read('needs_order_approval').checked,
        can_self_register: read('can_self_register').checked,
        is_active: read('is_active').checked,
      }));
      toast('Sector saved', 'success');
    } catch (error) { reportError(error); }
  });
}
