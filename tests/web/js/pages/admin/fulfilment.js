// =============================================================================
// fulfilment.js — Fulfilment → Pick list: what to pick for a warehouse and
// delivery day (confirmed orders not yet packed), plus the near-expiry batches
// with a one-click write-off. The shared tab strip for the fulfilment screens
// lives here. Packing itself is on the order (Orders → confirmed order).
// =============================================================================

import { html, mount, on, $, formatQty, formatINR, formatDate, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { getPickList, getExpiringBatches, writeOffExpired, listWarehouses } from '../../core/api.js';
import { pickListTotals, expiryTone } from '../../core/fulfilment.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';
import { DELIVERY_SLOTS } from '../../core/config.js';
import { tomorrowIso } from './buying-list.js';

/** Shared tab strip for the fulfilment screens. */
export function fulfilmentTabs(active) {
  const tabs = [
    { href: '#fulfilment', label: 'Pick list' },
    { href: '#trips', label: 'Trips' },
    { href: '#driver-cash', label: 'Driver cash' },
    { href: '#delivery-charges', label: 'Delivery charges' },
  ];
  return html`<div class="tabs" role="tablist">
    ${tabs.map((t) => html`<a role="tab" href="${t.href}" aria-selected="${String(t.href === active)}">${t.label}</a>`)}
  </div>`;
}

export async function renderPickList(container, me) {
  const canExport = can(me, 'fulfilment', 'export');
  const canWriteOff = can(me, 'inventory', 'edit');
  const warehouses = await listWarehouses();
  let warehouseId = warehouses.find((w) => w.id === me.profile.warehouse_id)?.id ?? warehouses.find((w) => w.is_default)?.id ?? warehouses[0]?.id ?? '';
  let date = tomorrowIso();
  let slot = '';
  let rows = [];
  let batches = [];

  async function load() {
    [rows, batches] = warehouseId
      ? await Promise.all([getPickList(warehouseId, date, slot || undefined), getExpiringBatches(warehouseId, 3)])
      : [[], []];
    draw();
  }

  function draw() {
    const t = pickListTotals(rows);
    mount(container, html`
      <div class="page-head"><div><h1>Pick list</h1><p>${t.products} products · ${formatQty(t.units)} units to pick for ${date}${slot ? ` · ${DELIVERY_SLOTS[slot]?.label}` : ''}</p></div>
        ${canExport ? html`<button class="btn" id="export">Export CSV</button>` : ''}</div>
      ${fulfilmentTabs('#fulfilment')}
      <div class="toolbar">
        <select class="select" id="warehouse">${warehouses.map((w) => html`<option value="${w.id}" ${w.id === warehouseId ? 'selected' : ''}>${w.name}</option>`)}</select>
        <input class="input" id="date" type="date" value="${date}">
        <select class="select" id="slot"><option value="">All slots</option>${Object.entries(DELIVERY_SLOTS).map(([k, v]) => html`<option value="${k}" ${k === slot ? 'selected' : ''}>${v.label}</option>`)}</select>
      </div>
      ${batches.length ? html`<div class="card card-pad" style="margin-bottom:var(--space-4)">
        <div class="spread"><strong>Expiring soon</strong>${canWriteOff && batches.some((b) => b.expired) ? html`<button class="btn small danger" id="writeoff">Write off expired</button>` : ''}</div>
        <ul class="diff" style="margin-top:var(--space-2)">${batches.map((b) => html`<li class="${expiryTone(b.days_left)}">${b.name} — ${formatQty(b.remaining_qty)} ${b.unit}${b.batch_no ? ` · ${b.batch_no}` : ''} · ${b.expired ? 'expired ' : 'expires '}${formatDate(b.expiry_date)}</li>`)}</ul></div>` : ''}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="right">To pick</th><th class="right">Orders</th><th class="right">Free stock</th><th class="right">Short</th></tr></thead>
        <tbody>${rows.length === 0 ? html`<tr><td colspan="5"><div class="empty">Nothing to pick. Confirm orders for this day first.</div></td></tr>` : rows.map((r) => html`
          <tr class="${Number(r.short) > 0 ? 'edited' : ''}">
            <td><strong>${r.name}</strong><div class="muted tiny">${r.sku} · ${r.unit} · ${r.category_name ?? ''}</div></td>
            <td class="right num money">${formatQty(r.pick_qty)}</td>
            <td class="right num">${r.orders}</td>
            <td class="right num">${formatQty(r.free_stock)}</td>
            <td class="right num ${Number(r.short) > 0 ? 'money' : 'muted'}">${Number(r.short) > 0 ? formatQty(r.short) : '—'}</td>
          </tr>`)}</tbody></table></div></div>`);
  }

  on(container, 'change', '#warehouse', async (_e, el) => { warehouseId = el.value; try { await load(); } catch (error) { reportError(error); } });
  on(container, 'change', '#date', async (_e, el) => { date = el.value || tomorrowIso(); try { await load(); } catch (error) { reportError(error); } });
  on(container, 'change', '#slot', async (_e, el) => { slot = el.value; try { await load(); } catch (error) { reportError(error); } });
  on(container, 'click', '#writeoff', async (_e, button) => {
    if (!(await confirmDialog('Write off every expired batch in this warehouse? This posts wastage movements.', { confirmText: 'Write off', danger: true }))) return;
    try {
      const r = await withBusy(button, () => writeOffExpired(warehouseId));
      toast(`${r.batches} batch${r.batches === 1 ? '' : 'es'} written off (${formatQty(r.qty)} units)`, 'success');
      await load();
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '#export', () => downloadCsv(`pick-list-${date}.csv`, rows, [
    { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'unit', label: 'Unit' },
    { key: 'pick_qty', label: 'To pick' }, { key: 'orders', label: 'Orders' }, { key: 'free_stock', label: 'Free stock' }, { key: 'short', label: 'Short' },
  ]));

  await load();
}
