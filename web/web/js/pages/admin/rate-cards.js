// =============================================================================
// rate-cards.js — Procurement → Rate cards: what each supplier charges per
// product (price, MOQ, lead days, validity) and which supplier is preferred.
// The preferred supplier's rate feeds the buying list and PO line costs.
// Suppliers themselves are added under Inventory → Suppliers.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, formatDate, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listSupplierProducts, saveSupplierProduct, deleteSupplierProduct, listSuppliers, listProducts } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { procurementTabs } from './buying-list.js';
import { todayIso } from './price-board.js';

export async function renderRateCards(container, me) {
  const editable = can(me, 'procurement', 'edit');
  let [rates, suppliers, products] = await Promise.all([listSupplierProducts(), listSuppliers(), listProducts()]);
  let supplierId = suppliers.find((s) => s.is_active)?.id ?? '';
  let search = '';

  async function reload() { rates = await listSupplierProducts(); draw(); }

  function draw() {
    const term = search.trim().toLowerCase();
    const list = products.filter((p) => p.is_active && (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)));
    const mine = (productId) => rates.find((r) => r.supplier_id === supplierId && r.product_id === productId);
    const others = (productId) => rates.filter((r) => r.product_id === productId && r.supplier_id !== supplierId);
    mount(container, html`
      <div class="page-head"><div><h1>Rate cards</h1><p>${rates.length} rates across ${new Set(rates.map((r) => r.supplier_id)).size} suppliers. Tick one preferred supplier per product.</p></div></div>
      ${procurementTabs('#rate-cards')}
      <div class="toolbar">
        <select class="select" id="supplier">${suppliers.map((s) => html`<option value="${s.id}" ${s.id === supplierId ? 'selected' : ''}>${s.name}${s.is_active ? '' : ' (inactive)'}</option>`)}</select>
        <input class="input search" id="search" type="search" placeholder="Search product…" value="${search}">
        ${editable ? html`<button class="btn primary" id="save-all">Save rates</button>` : ''}
      </div>
      ${suppliers.length === 0 ? html`<div class="empty"><strong>No suppliers yet</strong>Add them under Inventory → Suppliers.</div>` : html`
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="right">Price (₹)</th><th class="right">MOQ</th><th class="right">Lead days</th><th>Valid to</th><th>Preferred</th><th>Other suppliers</th><th></th></tr></thead>
        <tbody>${list.map((p) => { const r = mine(p.id); return html`<tr data-id="${p.id}" class="${r ? '' : 'muted'}">
          <td><strong>${p.name}</strong><div class="muted tiny">${p.sku} · per ${p.unit}</div></td>
          <td class="right">${editable ? html`<input class="input small num right" type="number" min="0" step="0.01" data-price="${p.id}" value="${r?.price ?? ''}" style="width:100px" aria-label="Price for ${p.name}">` : html`<span class="num">${r ? formatINR(r.price) : '—'}</span>`}</td>
          <td class="right">${editable ? html`<input class="input small num right" type="number" min="0.01" step="any" data-moq="${p.id}" value="${r?.moq ?? ''}" placeholder="1" style="width:80px" aria-label="MOQ">` : html`<span class="num">${r ? formatQty(r.moq) : ''}</span>`}</td>
          <td class="right">${editable ? html`<input class="input small num right" type="number" min="0" step="1" data-lead="${p.id}" value="${r?.lead_days ?? ''}" placeholder="1" style="width:70px" aria-label="Lead days">` : html`<span class="num">${r?.lead_days ?? ''}</span>`}</td>
          <td>${editable ? html`<input class="input small" type="date" data-valid-to="${p.id}" value="${r?.valid_to ?? ''}" aria-label="Valid to">` : html`${r?.valid_to ? formatDate(r.valid_to) : ''}`}</td>
          <td><input type="checkbox" data-preferred="${p.id}" ${r?.is_preferred ? 'checked' : ''} ${editable ? '' : 'disabled'} aria-label="Preferred for ${p.name}"></td>
          <td class="small">${others(p.id).map((o) => html`<div>${o.suppliers?.name}: ${formatINR(o.price)}${o.is_preferred ? ' ★' : ''}</div>`)}</td>
          <td class="right">${editable && r ? html`<button class="btn small" data-delete="${r.id}" title="Remove this rate">✕</button>` : ''}</td></tr>`; })}</tbody></table></div></div>`}`);
    const input = $('#search', container);
    if (input) input.oninput = () => { search = input.value; draw(); $('#search', container).focus(); };
  }

  on(container, 'change', '#supplier', (_e, el) => { supplierId = el.value; draw(); });
  on(container, 'click', '#save-all', async (_e, button) => {
    const changes = [];
    for (const input of container.querySelectorAll('[data-price]')) {
      const productId = input.dataset.price;
      const current = rates.find((r) => r.supplier_id === supplierId && r.product_id === productId);
      const row = {
        supplier_id: supplierId, product_id: productId, price: input.value,
        moq: container.querySelector(`[data-moq="${productId}"]`).value, lead_days: container.querySelector(`[data-lead="${productId}"]`).value,
        valid_to: container.querySelector(`[data-valid-to="${productId}"]`).value, is_preferred: container.querySelector(`[data-preferred="${productId}"]`).checked,
      };
      if (input.value === '') continue;
      const same = current && Number(current.price) === Number(row.price) && Number(current.moq) === (Number(row.moq) || 1)
        && Number(current.lead_days) === (Number(row.lead_days) || 1) && (current.valid_to ?? '') === row.valid_to && current.is_preferred === row.is_preferred;
      if (!same) changes.push({ ...row, valid_from: current?.valid_from ?? todayIso() });
    }
    if (!changes.length) { toast('Nothing changed', 'info'); return; }
    try {
      await withBusy(button, async () => { for (const c of changes) await saveSupplierProduct(c); });
      toast(`${changes.length} rate${changes.length === 1 ? '' : 's'} saved`, 'success');
      await reload();
    } catch (error) { reportError(/supplier_products_preferred_idx|duplicate/i.test(error.message) ? new Error('Another supplier is already preferred for that product. Untick it there first.') : error); }
  });
  on(container, 'click', '[data-delete]', async (_e, el) => {
    if (!(await confirmDialog('Remove this rate from the card?', { confirmText: 'Remove', danger: true }))) return;
    try { await deleteSupplierProduct(el.dataset.delete); await reload(); } catch (error) { reportError(error); }
  });

  draw();
}
