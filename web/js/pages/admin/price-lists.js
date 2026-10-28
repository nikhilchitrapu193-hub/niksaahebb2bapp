// =============================================================================
// price-lists.js — Admin: Contract pricing / Price list management (P2-3)
// Route: #price-lists (sub-page of #pricing)
//
// Admins can create price lists scoped to a sector or restaurant, add items
// with overridden prices, and assign a list to a restaurant.
// =============================================================================

import { html, mount, on, toast, modal, reportError, withBusy, formatINR } from '../../core/ui.js';
import { listPriceLists, savePriceList, listPriceListItems, savePriceListItem, assignPriceList, listProducts, listRestaurants } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { settingsTabs } from './settings.js';  // re-use settings tabs not needed here
import { renderPriceBoard } from './price-board.js';  // for pricing sub-tabs

export async function renderPriceLists(container, me) {
  const canEdit = can(me, 'pricing', 'edit');
  mount(container, html`
    <div class="page-head">
      <div><h1>Price lists</h1><p>Custom pricing for sectors or individual restaurants.</p></div>
      ${canEdit ? html`<button class="btn primary" id="new-pl-btn">+ New price list</button>` : ''}
    </div>
    <div id="pl-list"><div class="loading">Loading…</div></div>
  `);

  on(container, 'click', '#new-pl-btn', () => openPriceListForm(null, canEdit, reload));

  await reload();

  async function reload() {
    const pls = await listPriceLists().catch(() => []);
    const el  = container.querySelector('#pl-list');
    if (!pls.length) { mount(el, html`<p class="muted">No price lists yet. Create one to override product prices for specific customers.</p>`); return; }
    mount(el, html`
      <table class="data-table">
        <thead><tr><th>Name</th><th>Scope</th><th>Items</th><th>Status</th><th></th></tr></thead>
        <tbody>${pls.map((pl) => html`
          <tr>
            <td><strong>${pl.name}</strong></td>
            <td class="muted">${pl.kind === 'restaurant' ? `Restaurant: ${pl.restaurants?.name ?? pl.restaurant_id}` : pl.kind === 'sector' ? `Sector: ${pl.sectors?.name ?? pl.sector_id}` : `City: ${pl.city ?? '—'}`}</td>
            <td>${pl.price_list_items?.length ?? 0}</td>
            <td><span class="badge ${pl.is_active ? 'delivered' : 'cancelled'}">${pl.is_active ? 'Active' : 'Inactive'}</span></td>
            <td class="actions">
              <button class="btn small" data-edit-pl="${pl.id}">Edit / Items</button>
              ${canEdit ? html`<button class="btn small ghost" data-assign-pl="${pl.id}">Assign</button>` : ''}
            </td>
          </tr>
        `).join('')}
        </tbody>
      </table>
    `);

    on(el, 'click', '[data-edit-pl]', (_, btn) => {
      const pl = pls.find((p) => p.id === btn.dataset.editPl);
      if (pl) openPriceListForm(pl, canEdit, reload);
    });
    on(el, 'click', '[data-assign-pl]', (_, btn) => {
      const pl = pls.find((p) => p.id === btn.dataset.assignPl);
      if (pl) openAssignModal(pl, reload);
    });
  }
}

// ── Price list form ───────────────────────────────────────────────────────────
async function openPriceListForm(pl, canEdit, onSave) {
  const [products, items] = await Promise.all([
    listProducts().catch(() => []),
    pl ? listPriceListItems(pl.id).catch(() => []) : Promise.resolve([]),
  ]);

  const overlay = modal(html`
    <h3>${pl ? `Edit: ${pl.name}` : 'New price list'}</h3>
    <form id="pl-form" class="stack" novalidate>
      <div class="form-grid">
        <label class="field span-2"><span class="label">Name</span>
          <input class="input" name="name" value="${pl?.name ?? ''}" required maxlength="120" ${canEdit ? '' : 'disabled'}></label>
        <label class="field"><span class="label">Scope</span>
          <select class="select" name="kind" id="pl-kind" ${canEdit ? '' : 'disabled'}>
            <option value="sector"     ${(pl?.kind ?? 'sector') === 'sector'     ? 'selected' : ''}>Sector</option>
            <option value="restaurant" ${pl?.kind === 'restaurant' ? 'selected' : ''}>Restaurant</option>
            <option value="city"       ${pl?.kind === 'city'       ? 'selected' : ''}>City</option>
          </select></label>
        <label class="field"><span class="label">Status</span>
          <select class="select" name="is_active" ${canEdit ? '' : 'disabled'}>
            <option value="true"  ${pl?.is_active !== false ? 'selected' : ''}>Active</option>
            <option value="false" ${pl?.is_active === false  ? 'selected' : ''}>Inactive</option>
          </select></label>
      </div>
      ${canEdit ? html`<div><button class="btn primary" type="submit" id="save-pl-btn">Save price list</button></div>` : ''}
    </form>
    ${pl ? html`
      <hr>
      <div class="between" style="margin:var(--space-5) 0 var(--space-3)">
        <h4 style="margin:0">Price overrides (${items.length} items)</h4>
        ${canEdit ? html`<button class="btn small primary" id="add-item-btn">+ Add item</button>` : ''}
      </div>
      <div id="pl-items-list">
        ${items.length ? html`
          <table class="data-table">
            <thead><tr><th>Product</th><th>Custom price (₹)</th><th></th></tr></thead>
            <tbody>${items.map((it) => html`
              <tr>
                <td>${products.find((p) => p.id === it.product_id)?.name ?? it.product_id}</td>
                <td>${formatINR(it.price)}</td>
                <td class="actions">${canEdit ? html`<button class="btn small ghost" data-del-pli="${it.id}">Remove</button>` : ''}</td>
              </tr>
            `).join('')}</tbody>
          </table>` : html`<p class="muted">No item overrides yet.</p>`}
      </div>
    ` : ''}
  `);

  on(overlay, 'submit', '#pl-form', async (e, form) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await withBusy(overlay.querySelector('#save-pl-btn'), () =>
        savePriceList({ id: pl?.id, name: fd.get('name'), kind: fd.get('kind'), is_active: fd.get('is_active') === 'true' }));
      toast(pl ? 'Price list updated' : 'Price list created', 'success');
      overlay.remove();
      onSave();
    } catch (err) { reportError(err); }
  });

  if (pl && canEdit) {
    on(overlay, 'click', '#add-item-btn', () => openItemForm(pl.id, products, () => {
      // Refresh items in the modal
      listPriceListItems(pl.id).then((its) => {
        mount(overlay.querySelector('#pl-items-list'), html`
          <table class="data-table">
            <thead><tr><th>Product</th><th>Custom price (₹)</th><th></th></tr></thead>
            <tbody>${its.map((it) => html`
              <tr>
                <td>${products.find((p) => p.id === it.product_id)?.name ?? it.product_id}</td>
                <td>${formatINR(it.price)}</td>
                <td class="actions"><button class="btn small ghost" data-del-pli="${it.id}">Remove</button></td>
              </tr>
            `).join('')}</tbody>
          </table>`);
      });
    }));
  }
}

function openItemForm(priceListId, products, onSave) {
  const m = modal(html`
    <h4>Add price override</h4>
    <form id="pli-form" class="stack" novalidate>
      <label class="field"><span class="label">Product</span>
        <select class="select" name="product_id" required>
          <option value="">— choose —</option>
          ${products.map((p) => html`<option value="${p.id}">${p.name} (₹${p.price}/${p.unit})</option>`)}
        </select></label>
      <label class="field"><span class="label">Custom price (₹)</span>
        <input class="input" name="price" type="number" min="0" step="0.01" required placeholder="0.00"></label>
      <div><button class="btn primary" type="submit">Add</button></div>
    </form>
  `);
  on(m, 'submit', '#pli-form', async (e, form) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await savePriceListItem({ price_list_id: priceListId, product_id: fd.get('product_id'), price: Number(fd.get('price')) });
      toast('Item added');
      m.remove();
      onSave();
    } catch (err) { reportError(err); }
  });
}

function openAssignModal(pl, onSave) {
  const m = modal(html`
    <h4>Assign "${pl.name}" to a restaurant</h4>
    <p class="muted">This will set this price list for a specific restaurant, overriding any sector-level list they're in.</p>
    <form id="assign-form" class="stack" novalidate>
      <label class="field"><span class="label">Restaurant ID</span>
        <input class="input" name="restaurant_id" placeholder="uuid of the restaurant" required maxlength="36"></label>
      <div><button class="btn primary" type="submit">Assign</button></div>
    </form>
  `);
  on(m, 'submit', '#assign-form', async (e, form) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await assignPriceList(pl.id, fd.get('restaurant_id'));
      toast('Price list assigned');
      m.remove();
      onSave();
    } catch (err) { reportError(err); }
  });
}
