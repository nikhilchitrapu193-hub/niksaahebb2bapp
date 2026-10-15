// =============================================================================
// buying-list.js — Procurement → Buying list: what to buy for a warehouse and
// delivery day. Per product: demand on open orders for that day, free stock,
// what is already on order, the preferred supplier's rate, and a suggested
// quantity (buying_list() in the database; suggestedBuy() mirrors it so the
// "days of cover" box recalculates instantly). Tick rows, adjust quantities,
// and "Create purchase orders" makes one draft PO per supplier.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { getBuyingList, listWarehouses, listSuppliers, createPurchaseOrder } from '../../core/api.js';
import { suggestedBuy, roundToMoq, groupBySupplier } from '../../core/procurement.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';
import { todayIso } from './price-board.js';

/** Shared tab strip for the procurement screens. */
export function procurementTabs(active) {
  const tabs = [
    { href: '#procurement', label: 'Buying list' },
    { href: '#purchase-orders', label: 'Purchase orders' },
    { href: '#receipts', label: 'Receipts' },
    { href: '#rate-cards', label: 'Rate cards' },
  ];
  return html`<div class="tabs" role="tablist">
    ${tabs.map((t) => html`<a role="tab" href="${t.href}" aria-selected="${String(t.href === active)}">${t.label}</a>`)}
  </div>`;
}

/** Tomorrow in the business time zone, YYYY-MM-DD. */
export function tomorrowIso() {
  const d = new Date(`${todayIso()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function renderBuyingList(container, me) {
  const canEdit = can(me, 'procurement', 'edit');
  const canExport = can(me, 'procurement', 'export');
  const [warehouses, suppliers] = await Promise.all([listWarehouses(), listSuppliers()]);
  let warehouseId = warehouses.find((w) => w.id === me.profile.warehouse_id)?.id ?? warehouses.find((w) => w.is_default)?.id ?? warehouses[0]?.id ?? '';
  let date = tomorrowIso();
  let coverDays = 1;
  let onlyNeeded = true;
  let rows = [];
  const chosen = new Map();   // product_id → quantity to buy

  async function load() {
    rows = warehouseId ? await getBuyingList(warehouseId, date, coverDays) : [];
    chosen.clear();
    draw();
  }

  const visible = () => rows.filter((r) => !onlyNeeded || suggestedBuy(r, coverDays) > 0 || Number(r.demand_qty) > 0);

  function draw() {
    const list = visible();
    mount(container, html`
      <div class="page-head"><div><h1>Buying list</h1><p>${rows.filter((r) => suggestedBuy(r, coverDays) > 0).length} products to buy for ${date} · demand from open orders, free stock and open purchase orders.</p></div>
        <div class="row">
          ${canExport ? html`<button class="btn" id="export">Export CSV</button>` : ''}
          ${canEdit ? html`<button class="btn primary" id="create-po" ${chosen.size ? '' : 'disabled'}>Create purchase orders${chosen.size ? ` (${chosen.size})` : ''}</button>` : ''}
        </div></div>
      ${procurementTabs('#procurement')}
      <div class="toolbar">
        <select class="select" id="warehouse">${warehouses.map((w) => html`<option value="${w.id}" ${w.id === warehouseId ? 'selected' : ''}>${w.name}</option>`)}</select>
        <input class="input" id="date" type="date" value="${date}">
        <label class="field" style="flex-direction:row;align-items:center;gap:var(--space-2)"><span class="label" style="margin:0">Days of cover</span><input class="input" id="cover" type="number" min="0.5" step="0.5" value="${coverDays}" style="width:80px"></label>
        <label class="check small"><input type="checkbox" id="only-needed" ${onlyNeeded ? 'checked' : ''}> Only products with demand or a shortfall</label>
      </div>
      <div class="card"><div class="table-wrap"><table class="table board">
        <thead><tr>${canEdit ? html`<th></th>` : ''}<th>Product</th><th class="right">Demand</th><th class="right">Free stock</th><th class="right">On order</th><th class="right">Alert level</th><th class="right">Suggested</th><th>Supplier</th><th class="right">Rate</th><th class="right">Buy</th></tr></thead>
        <tbody>${list.length === 0 ? html`<tr><td colspan="10"><div class="empty">Nothing to buy for this day. Untick the filter to see every product.</div></td></tr>` : list.map((r) => {
          const suggested = suggestedBuy(r, coverDays);
          const qty = chosen.get(r.product_id) ?? roundToMoq(suggested, r.moq);
          return html`<tr data-id="${r.product_id}" class="${chosen.has(r.product_id) ? 'edited' : ''}">
            ${canEdit ? html`<td><input type="checkbox" data-pick="${r.product_id}" ${chosen.has(r.product_id) ? 'checked' : ''} aria-label="Buy ${r.name}"></td>` : ''}
            <td class="name"><strong>${r.name}</strong><div class="muted tiny">${r.sku} · ${r.unit} · ${r.category_name ?? ''}</div></td>
            <td class="right num">${formatQty(r.demand_qty)}<div class="muted tiny">${r.demand_orders} order${Number(r.demand_orders) === 1 ? '' : 's'}</div></td>
            <td class="right num">${formatQty(r.free_stock)}</td>
            <td class="right num">${formatQty(r.open_po_qty)}</td>
            <td class="right num muted">${formatQty(r.low_stock_threshold)}</td>
            <td class="right num ${suggested > 0 ? 'money' : 'muted'}">${formatQty(suggested)}</td>
            <td>${r.supplier_name ? html`${r.supplier_name}<div class="muted tiny">MOQ ${formatQty(r.moq)} · ${r.lead_days} d</div>` : html`<span class="muted">no rate card</span>`}</td>
            <td class="right num">${r.rate != null ? formatINR(r.rate) : html`<span class="muted">${r.latest_cost != null ? `last ${formatINR(r.latest_cost)}` : '—'}</span>`}</td>
            <td class="right">${canEdit ? html`<input class="input small num right" type="number" min="0" step="any" data-qty="${r.product_id}" value="${qty}" style="width:92px" aria-label="Quantity to buy for ${r.name}">` : formatQty(qty)}</td>
          </tr>`; })}</tbody></table></div></div>
      <p class="muted small" style="margin-top:var(--space-3)">Orders reserve stock when placed, so the day's demand is already covered by free stock when it is ≥ 0. Suggested = demand × days of cover + alert level − free stock − on order, rounded up to the supplier's MOQ.</p>`);
  }

  on(container, 'change', '#warehouse', async (_e, el) => { warehouseId = el.value; try { await load(); } catch (error) { reportError(error); } });
  on(container, 'change', '#date', async (_e, el) => { date = el.value || tomorrowIso(); try { await load(); } catch (error) { reportError(error); } });
  on(container, 'input', '#cover', (_e, el) => { coverDays = Number(el.value) || 1; chosen.clear(); draw(); $('#cover', container).focus(); });
  on(container, 'change', '#only-needed', (_e, el) => { onlyNeeded = el.checked; draw(); });
  on(container, 'change', '[data-pick]', (_e, el) => {
    const r = rows.find((x) => x.product_id === el.dataset.pick);
    if (el.checked) chosen.set(r.product_id, Number(container.querySelector(`[data-qty="${r.product_id}"]`)?.value) || roundToMoq(suggestedBuy(r, coverDays), r.moq));
    else chosen.delete(r.product_id);
    draw();
  });
  on(container, 'change', '[data-qty]', (_e, el) => {
    const r = rows.find((x) => x.product_id === el.dataset.qty);
    chosen.set(r.product_id, Number(el.value) || 0);
    draw();
  });
  on(container, 'click', '#export', () => downloadCsv(`buying-list-${date}.csv`, visible().map((r) => ({ ...r, suggested: suggestedBuy(r, coverDays) })), [
    { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'unit', label: 'Unit' }, { key: 'demand_qty', label: 'Demand' },
    { key: 'free_stock', label: 'Free stock' }, { key: 'open_po_qty', label: 'On order' }, { key: 'low_stock_threshold', label: 'Alert level' },
    { key: 'suggested', label: 'Suggested' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'rate', label: 'Rate' }, { key: 'moq', label: 'MOQ' },
  ]));
  on(container, 'click', '#create-po', () => createDialog());

  /** One draft PO per supplier from the ticked rows. */
  function createDialog() {
    const picked = rows.filter((r) => chosen.has(r.product_id) && chosen.get(r.product_id) > 0).map((r) => ({ ...r, quantity: chosen.get(r.product_id) }));
    const groups = groupBySupplier(picked);
    const { el, close } = openModal(html`
      <form id="po-create" class="stack" novalidate>
        ${groups.map((g, n) => html`<div class="card card-pad">
          <div class="spread"><strong>${g.supplier_name ?? 'No preferred supplier'}</strong>
            ${g.supplier_id ? html`<input type="hidden" name="supplier-${n}" value="${g.supplier_id}">` : html`<select class="select" name="supplier-${n}" required><option value="">Choose a supplier…</option>
              ${suppliers.filter((s) => s.is_active).map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select>`}</div>
          <ul class="diff" style="margin-top:var(--space-2)">${g.lines.map((l) => html`<li>${l.name}: ${formatQty(l.quantity)} ${l.unit}${l.unit_cost != null ? ` @ ${formatINR(l.unit_cost)}` : ''}</li>`)}</ul>
        </div>`)}
        <div class="form-grid">
          <label class="field"><span class="label">Deliver by</span><input class="input" name="expected_date" type="date" value="${date}"></label>
          <label class="field"><span class="label">Note to the supplier</span><input class="input" name="notes" maxlength="300"></label>
        </div>
        <p class="form-error" id="po-error" role="alert"></p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Create ${groups.length} draft${groups.length === 1 ? '' : 's'}</button></div>
      </form>`, { title: 'Create purchase orders', wide: true });
    $('#po-create', el).onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target;
      if (!form.checkValidity()) { $('#po-error', el).textContent = 'Choose a supplier for every group.'; return; }
      try {
        const made = await withBusy($('button[type="submit"]', form), async () => {
          const numbers = [];
          for (const [n, g] of groups.entries()) {
            const result = await createPurchaseOrder({
              supplierId: form.elements[`supplier-${n}`].value, warehouseId, expectedDate: form.elements.expected_date.value, notes: form.elements.notes.value,
              items: g.lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_cost: l.unit_cost })),
            });
            numbers.push(result.po_number);
          }
          return numbers;
        });
        toast(`Draft${made.length === 1 ? '' : 's'} ${made.join(', ')} created — approve under Purchase orders`, 'success');
        close(); await load();
      } catch (error) { $('#po-error', el).textContent = error.message; }
    };
  }

  await load();
}
