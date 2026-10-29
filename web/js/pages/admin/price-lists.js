// =============================================================================
// price-lists.js — Pricing → Price lists: what each city and / or sector pays.
//
// A list is a % adjustment over the published price (−5 = 5 % cheaper) plus
// fixed prices for chosen products. The database picks the most specific
// active list for a customer (city + sector, then sector, then city) in
// customer_price(), which place_order charges and the customer app shows.
// Needs pricing:view to see, pricing:edit to change.
// =============================================================================

import { html, mount, on, $, formatINR, openModal, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listPriceLists, savePriceList, deletePriceList, listPriceListItems, savePriceListItems, deletePriceListItem,
         listCities, listSectors, listProducts } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { pricingTabs } from './price-board.js';

/** Price a customer on this list pays for a product: fixed item, else published × (1 + adjustment). Pure; mirrors customer_price(). */
export function listPrice(product, list, items) {
  const fixed = items.find((i) => i.product_id === product.id);
  if (fixed) return Number(fixed.price);
  return Math.round(Number(product.price) * (1 + Number(list.adjustment_pct) / 100) * 100) / 100;
}

export async function renderPriceLists(container, me) {
  const editable = can(me, 'pricing', 'edit');
  let [lists, cities, sectors, products] = await Promise.all([listPriceLists(), listCities(), listSectors(), listProducts()]);
  let selected = lists[0]?.id ?? null;
  let items = selected ? await listPriceListItems(selected) : [];
  let search = '';

  async function reload(keep = selected) {
    lists = await listPriceLists();
    selected = lists.some((l) => l.id === keep) ? keep : (lists[0]?.id ?? null);
    items = selected ? await listPriceListItems(selected) : [];
    draw();
  }

  const scopeOf = (l) => [l.cities?.name ?? 'Every city', l.sectors?.name ?? 'Every sector'].join(' · ');

  function draw() {
    const list = lists.find((l) => l.id === selected);
    const term = search.trim().toLowerCase();
    const rows = products.filter((p) => p.is_active && (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)));
    mount(container, html`
      <div class="page-head"><div><h1>Price lists</h1><p>A % over or under the published price per city and sector, with fixed prices where needed. The most specific list wins.</p></div>
        ${editable ? html`<button class="btn primary" id="new-list">New price list</button>` : ''}</div>
      ${pricingTabs('#price-lists')}
      ${lists.length === 0 ? html`<div class="empty"><strong>No price lists yet</strong>Everyone pays the published price. Add a list for a sector (hotels −3 %) or a city.</div>` : html`
      <div class="toolbar">
        <select class="select" id="list">${lists.map((l) => html`<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>${l.name}${l.is_active ? '' : ' (inactive)'} — ${scopeOf(l)}</option>`)}</select>
        ${editable && list ? html`<button class="btn" id="edit-list">Edit list</button><button class="btn danger" id="delete-list">Delete</button>` : ''}
        <input class="input search" id="search" type="search" placeholder="Search product…" value="${search}">
      </div>
      ${list ? html`<div class="banner info"><div><strong>${list.name}</strong> · ${scopeOf(list)} · ${Number(list.adjustment_pct) === 0 ? 'published price' : `${Number(list.adjustment_pct) > 0 ? '+' : ''}${Number(list.adjustment_pct)}% on the published price`} · ${items.length} fixed price${items.length === 1 ? '' : 's'}${list.note ? html` · ${list.note}` : ''}</div></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="right">Published</th><th class="right">On this list</th><th class="right">Fixed price (₹)</th><th></th></tr></thead>
        <tbody>${rows.map((p) => { const fixed = items.find((i) => i.product_id === p.id); return html`<tr data-id="${p.id}">
          <td><strong>${p.name}</strong><div class="muted tiny">${p.sku} · per ${p.unit}</div></td>
          <td class="right num">${formatINR(p.price)}</td>
          <td class="right num ${fixed ? 'money' : ''}">${formatINR(listPrice(p, list, items))}${fixed ? html`<div class="muted tiny">fixed</div>` : ''}</td>
          <td class="right">${editable ? html`<input class="input small num right" type="number" min="0" step="0.01" data-fixed="${p.id}" value="${fixed?.price ?? ''}" style="width:110px" aria-label="Fixed price for ${p.name}">` : html`<span class="num">${fixed ? formatINR(fixed.price) : '—'}</span>`}</td>
          <td class="right">${editable && fixed ? html`<button class="btn small" data-clear="${p.id}" title="Back to the % rule">Clear</button>` : ''}</td></tr>`; })}</tbody></table></div></div>
      ${editable ? html`<div class="row" style="margin-top:var(--space-3);justify-content:flex-end"><button class="btn primary" id="save-fixed">Save fixed prices</button></div>` : ''}` : ''}`}`);
    const input = $('#search', container);
    if (input) input.oninput = () => { search = input.value; draw(); $('#search', container).focus(); };
  }

  on(container, 'change', '#list', async (_e, el) => { selected = el.value; items = await listPriceListItems(selected); draw(); });
  on(container, 'click', '#new-list', () => listForm(null, { cities, sectors }, (saved) => reload(saved.id)));
  on(container, 'click', '#edit-list', () => listForm(lists.find((l) => l.id === selected), { cities, sectors }, () => reload()));
  on(container, 'click', '#delete-list', async () => {
    if (!(await confirmDialog('Delete this price list? Customers it covered go back to the published price.', { confirmText: 'Delete', danger: true }))) return;
    try { await deletePriceList(selected); toast('Price list deleted', 'success'); await reload(null); } catch (error) { reportError(error); }
  });
  on(container, 'click', '#save-fixed', async (_e, button) => {
    const rows = [];
    for (const input of container.querySelectorAll('[data-fixed]')) {
      const current = items.find((i) => i.product_id === input.dataset.fixed);
      if (input.value === '' && !current) continue;
      if (input.value === '' && current) continue;                    // cleared with the Clear button
      if (current && Number(current.price) === Number(input.value)) continue;
      rows.push({ product_id: input.dataset.fixed, price: Number(input.value) });
    }
    if (!rows.length) { toast('Nothing changed', 'info'); return; }
    try { await withBusy(button, () => savePriceListItems(selected, rows)); toast(`${rows.length} fixed price${rows.length === 1 ? '' : 's'} saved`, 'success'); await reload(); }
    catch (error) { reportError(error); }
  });
  on(container, 'click', '[data-clear]', async (_e, el) => {
    try { await deletePriceListItem(selected, el.dataset.clear); await reload(); } catch (error) { reportError(error); }
  });

  draw();
}

function listForm(list, { cities, sectors }, onSaved) {
  const l = list ?? { adjustment_pct: 0, is_active: true };
  const { el, close } = openModal(html`
    <form id="list-form" class="stack" novalidate>
      <div class="form-grid">
        <label class="field span-2"><span class="label">Name</span><input class="input" name="name" value="${l.name ?? ''}" required maxlength="80" placeholder="Hotels −3 %"></label>
        <label class="field"><span class="label">City</span><select class="select" name="city_id"><option value="">Every city</option>
          ${cities.map((c) => html`<option value="${c.id}" ${c.id === l.city_id ? 'selected' : ''}>${c.name}</option>`)}</select></label>
        <label class="field"><span class="label">Sector</span><select class="select" name="sector_code"><option value="">Every sector</option>
          ${sectors.map((s) => html`<option value="${s.code}" ${s.code === l.sector_code ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label class="field"><span class="label">Adjustment % on the published price</span><input class="input" name="adjustment_pct" type="number" min="-100" max="500" step="0.1" value="${l.adjustment_pct ?? 0}" required><span class="hint">−5 = 5 % cheaper, 2 = 2 % dearer, 0 = fixed prices only</span></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="is_active" ${l.is_active ? 'checked' : ''}> Active</label>
        <label class="field span-2"><span class="label">Note</span><input class="input" name="note" value="${l.note ?? ''}" maxlength="200"></label>
      </div>
      <p class="muted small">One list per city + sector combination. City + sector beats sector only, which beats city only.</p>
      <p class="form-error" id="list-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save list</button></div>
    </form>`, { title: list ? 'Edit price list' : 'New price list' });
  $('#list-form', el).onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.checkValidity()) { $('#list-error', el).textContent = 'Please fill in the name and the adjustment.'; return; }
    const v = Object.fromEntries(new FormData(form));
    try {
      const saved = await withBusy($('button[type="submit"]', form), () => savePriceList({ ...v, id: list?.id, is_active: form.elements.is_active.checked }));
      toast('Price list saved', 'success');
      close(); onSaved(saved);
    } catch (error) { $('#list-error', el).textContent = /duplicate|already exists/i.test(error.message) ? 'There is already a list for this city and sector.' : error.message; }
  };
}
