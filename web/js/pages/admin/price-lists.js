// =============================================================================
// price-lists.js — Admin: Price list management
// Route: #price-lists (sub-page of #pricing)
//
// Shows a table of ALL products with their computed price for the selected list.
// Fixed-price overrides per product are editable inline.
// Admins can create a new price list with name, city, sector, adjustment %.
// =============================================================================

import { html, mount, on, toast, modal, reportError, withBusy, formatINR } from '../../core/ui.js';
import { listPriceLists, savePriceList, upsertPriceListItems, listProducts, listPriceListItems } from '../../core/api.js';
import { can } from '../../core/permissions.js';

/**
 * Compute the effective price for a product under a price list.
 * Fixed per-item overrides (price_list_items) beat the list's adjustment_pct.
 */
export function listPrice(product, list, items) {
  const fixed = (items ?? []).find((i) => i.product_id === product.id);
  if (fixed) return fixed.price;
  const pct = list?.adjustment_pct ?? 0;
  return product.price * (1 + pct / 100);
}

export async function renderPriceLists(container, me) {
  const canEdit = can(me, 'pricing', 'edit');

  // Load lists and products in parallel
  const [lists, products] = await Promise.all([
    listPriceLists().catch(() => []),
    listProducts().catch(() => []),
  ]);

  // Default to first list
  let selectedListId = lists[0]?.id ?? null;
  let fixedItems = [];

  mount(container, html`
    <div class="page-head">
      <div><h1>Price lists</h1><p>Custom pricing for sectors or individual restaurants.</p></div>
      ${canEdit ? html`<button class="btn primary" id="new-list">+ New list</button>` : ''}
    </div>
    <div class="filters row gap-sm mb-md">
      <label>List
        <select class="select-sm" id="list-select">
          ${lists.map((l) => html`<option value="${l.id}">${l.name}</option>`)}
        </select>
      </label>
    </div>
    <div id="list-info" class="muted small mb-md"></div>
    <table class="data-table" id="products-table">
      <thead><tr><th>Product</th><th>Base price</th><th>List price</th><th>Fixed override</th></tr></thead>
      <tbody id="products-body"></tbody>
    </table>
    ${canEdit ? html`<div class="row gap-2 mt-md"><button class="btn primary" id="save-fixed">Save fixed prices</button></div>` : ''}
    <div id="list-form" hidden class="card card-pad mt-md">
      <h3>New price list</h3>
      <form id="pl-form" class="stack" novalidate>
        <label class="field"><span class="label">Name</span><input class="input" name="name" required maxlength="120"></label>
        <label class="field"><span class="label">City ID (leave blank for all cities)</span><input class="input" name="city_id" placeholder="city UUID or blank"></label>
        <label class="field"><span class="label">Sector code</span><input class="input" name="sector_code" placeholder="e.g. hotel" maxlength="40"></label>
        <label class="field"><span class="label">Adjustment % (e.g. -3 for 3% off)</span><input class="input" type="number" name="adjustment_pct" value="0" step="0.01"></label>
        <div class="row gap-2">
          <button class="btn primary" type="submit" id="save-list-btn">Create list</button>
          <button class="btn ghost" type="button" id="cancel-list-btn">Cancel</button>
        </div>
      </form>
    </div>
  `);

  async function loadItems() {
    if (!selectedListId) { fixedItems = []; renderRows(); return; }
    fixedItems = await listPriceListItems(selectedListId).catch(() => []);
    renderRows();
  }

  function selectedList() {
    return lists.find((l) => l.id === selectedListId) ?? null;
  }

  function renderRows() {
    const list = selectedList();
    const info = container.querySelector('#list-info');
    if (list) {
      const scope = list.sectors?.name ? `Sector: ${list.sectors.name}` : list.cities?.name ? `City: ${list.cities.name}` : 'All';
      mount(info, html`${list.name} · ${scope} · ${list.adjustment_pct >= 0 ? '+' : ''}${list.adjustment_pct}%`);
    }
    const tbody = container.querySelector('#products-body');
    mount(tbody, html`${products.map((p) => {
      const fixedItem = fixedItems.find((i) => i.product_id === p.id);
      const effectivePrice = listPrice(p, list, fixedItems);
      const isFixed = Boolean(fixedItem);
      return html`<tr data-id="${p.id}">
        <td>${p.name}</td>
        <td>${formatINR(p.price)}</td>
        <td>${isFixed ? 'fixed' : formatINR(effectivePrice)}</td>
        <td>${canEdit ? html`<input class="input-sm" type="number" min="0" step="0.01"
          data-fixed="${p.id}"
          value=""
          placeholder="${fixedItem ? fixedItem.price : formatINR(effectivePrice).replace('₹', '')}">` : (fixedItem ? formatINR(fixedItem.price) : '—')}
        </td>
      </tr>`;
    })}`);
  }

  on(container, 'change', '#list-select', (e) => {
    selectedListId = e.target.value;
    loadItems();
  });

  on(container, 'click', '#new-list', () => {
    container.querySelector('#list-form').hidden = false;
  });
  on(container, 'click', '#cancel-list-btn', () => {
    container.querySelector('#list-form').hidden = true;
  });

  on(container, 'submit', '#list-form', async (e, listForm) => {
    e.preventDefault();
    const form = listForm.querySelector('form') ?? listForm;
    const fd = new FormData(form);
    const btn = form.querySelector('#save-list-btn');
    try {
      await withBusy(btn, () => savePriceList({
        name: fd.get('name'),
        city_id: fd.get('city_id') || null,
        sector_code: fd.get('sector_code') || null,
        adjustment_pct: Number(fd.get('adjustment_pct')) || 0,
        is_active: true,
      }));
      toast('Price list created', 'success');
      container.querySelector('#list-form').hidden = true;
      form.reset();
    } catch (err) { reportError(err); }
  });

  on(container, 'click', '#save-fixed', async (_, btn) => {
    if (!selectedListId) return;
    const inputs = container.querySelectorAll('[data-fixed]');
    const items = [];
    inputs.forEach((inp) => {
      const val = inp.value.trim();
      if (val !== '') {
        items.push({ price_list_id: selectedListId, product_id: inp.dataset.fixed, price: Number(val), note: null });
      }
    });
    try {
      await withBusy(btn, () => upsertPriceListItems(items));
      toast('Fixed prices saved', 'success');
      await loadItems();
    } catch (err) { reportError(err); }
  });

  await loadItems();
}
