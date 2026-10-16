// =============================================================================
// driver-cash.js — Fulfilment → Driver cash: for each driver, the COD cash
// collected on delivery, what has been settled, and what is still in hand.
// Settling needs fulfilment:approve or payments:edit (finance).
// =============================================================================

import { html, mount, on, $, formatINR, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { getDriverCashSummary, settleDriverCash } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';
import { fulfilmentTabs } from './fulfilment.js';

export async function renderDriverCash(container, me) {
  const canSettle = can(me, 'fulfilment', 'approve') || can(me, 'payments', 'edit');
  let rows = await getDriverCashSummary();

  async function reload() { rows = await getDriverCashSummary(); draw(); }

  function draw() {
    const totalInHand = rows.reduce((s, r) => s + Number(r.in_hand || 0), 0);
    mount(container, html`
      <div class="page-head"><div><h1>Driver cash</h1><p>${formatINR(totalInHand)} held across ${rows.length} driver${rows.length === 1 ? '' : 's'}</p></div>
        ${rows.length ? html`<button class="btn" id="export">Export CSV</button>` : ''}</div>
      ${fulfilmentTabs('#driver-cash')}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Driver</th><th class="right">Orders</th><th class="right">Collected</th><th class="right">Settled</th><th class="right">In hand</th><th></th></tr></thead>
        <tbody>${rows.length === 0 ? html`<tr><td colspan="6"><div class="empty">No COD cash collected yet.</div></td></tr>` : rows.map((r) => html`
          <tr><td><strong>${r.driver_name ?? '—'}</strong></td>
            <td class="right num">${r.orders}</td><td class="right num">${formatINR(r.collected)}</td><td class="right num">${formatINR(r.settled)}</td>
            <td class="right num ${Number(r.in_hand) > 0 ? 'money' : 'muted'}">${formatINR(r.in_hand)}</td>
            <td class="right">${canSettle && Number(r.in_hand) > 0 ? html`<button class="btn small primary" data-settle="${r.driver_id}" data-name="${r.driver_name ?? ''}" data-max="${r.in_hand}">Settle</button>` : ''}</td></tr>`)}</tbody></table></div></div>`);
  }

  on(container, 'click', '[data-settle]', (_e, el) => settleDialog(el.dataset.settle, el.dataset.name, Number(el.dataset.max)));
  on(container, 'click', '#export', () => downloadCsv('driver-cash.csv', rows, [
    { key: 'driver_name', label: 'Driver' }, { key: 'orders', label: 'Orders' }, { key: 'collected', label: 'Collected' }, { key: 'settled', label: 'Settled' }, { key: 'in_hand', label: 'In hand' },
  ]));

  function settleDialog(driverId, name, max) {
    const { el, close } = openModal(html`
      <form id="settle" class="stack" novalidate>
        <p>Record cash received from <strong>${name}</strong>. In hand: <strong>${formatINR(max)}</strong>.</p>
        <label class="field"><span class="label">Amount received (₹)</span><input class="input" name="amount" type="number" min="0.01" step="0.01" value="${max}" required></label>
        <label class="field"><span class="label">Note</span><input class="input" name="note" maxlength="300" placeholder="Deposited, reference…"></label>
        <p class="form-error" id="settle-error" role="alert"></p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Record settlement</button></div>
      </form>`, { title: 'Settle driver cash' });
    $('#settle', el).onsubmit = async (event) => {
      event.preventDefault();
      const amount = Number(event.target.elements.amount.value);
      if (!amount || amount <= 0) { $('#settle-error', el).textContent = 'Enter an amount.'; return; }
      try {
        await withBusy($('button[type="submit"]', event.target), () => settleDriverCash(driverId, amount, event.target.elements.note.value));
        toast('Settlement recorded', 'success'); close(); await reload();
      } catch (error) { $('#settle-error', el).textContent = error.message; }
    };
  }

  draw();
}
