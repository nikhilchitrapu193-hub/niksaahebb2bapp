// =============================================================================
// products.js — catalogue management: add/edit products (details, HSN, pack
// size, grade / origin, veg type, loose-weight billing, pack-size variants),
// upload photos, toggle stock / visibility, manage the two-level category
// tree, bulk upload from CSV, and choose the cities where each product is
// listed (hidden in a city = invisible and unorderable there).
// Buttons that change data appear only with products:edit; the database
// refuses the write without it anyway.
// =============================================================================

import { html, mount, on, $, formatINR, openModal, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listProducts, listCategories, saveProduct, setProductFlags, uploadProductPhoto, photoUrl,
         saveCategory, deleteCategory, listCities, listProductAvailability, setProductAvailability, listHsnCodes, upsertProducts } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { PACK_UNITS, VEG_TYPES } from '../../core/config.js';
import { categoryOptions } from '../../core/catalogue.js';
import { parseCsv, readTextFile } from '../../core/csv.js';
import { csvToProducts } from '../../core/csv-import.js';

export async function renderProducts(container, me) {
  let search = '';
  const editable = can(me, 'products', 'edit');
  let [products, categories, cities, availability, hsnCodes] = await Promise.all([listProducts(), listCategories(), listCities(), listProductAvailability(), listHsnCodes()]);

  async function reload() {
    [products, categories, availability] = await Promise.all([listProducts(), listCategories(), listProductAvailability()]);
    draw();
  }

  /** Names of cities where this product is hidden. */
  const hiddenIn = (productId) => availability
    .filter((a) => a.product_id === productId && !a.is_available)
    .map((a) => cities.find((c) => c.id === a.city_id)?.name ?? '?');

  function draw() {
    const term = search.trim().toLowerCase();
    const rows = products.filter((p) => !term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term));
    mount(container, html`
      <div class="page-head"><div><h1>Products</h1><p>${products.length} products</p></div>
        ${editable ? html`<div class="row"><button class="btn" id="categories">Categories</button><button class="btn" id="upload">Upload CSV</button><button class="btn primary" id="new">Add product</button></div>` : ''}</div>
      <div class="toolbar"><input class="input search" id="search" type="search" placeholder="Search name or SKU…" value="${search}"></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th></th><th>Product</th><th>Category</th><th class="right">Price</th><th class="right">On hand</th><th>Stock</th><th>Listed</th><th></th></tr></thead>
        <tbody>${rows.length === 0 ? html`<tr><td colspan="8"><div class="empty">No products.</div></td></tr>`
          : rows.map((p) => html`<tr>
            <td>${p.photo_path ? html`<img class="thumb" src="${photoUrl(p.photo_path)}" alt="">` : html`<div class="thumb-empty">—</div>`}</td>
            <td><strong>${p.name}</strong><div class="muted small">${p.sku} · min ${Number(p.min_order_qty)} ${p.unit}${p.parent_product_id ? html` · pack of <em>${products.find((x) => x.id === p.parent_product_id)?.name ?? '?'}</em>` : ''}${p.sold_by_weight ? ' · by weight' : ''}</div>
              ${hiddenIn(p.id).length ? html`<div class="tiny" style="color:var(--accent)">Hidden in ${hiddenIn(p.id).join(', ')}</div>` : ''}</td>
            <td>${categoryOptions(categories).find((c) => c.id === p.category_id)?.path ?? p.categories?.name ?? '—'}</td>
            <td class="right money">${formatINR(p.price)}<div class="muted tiny">per ${p.unit}${p.gst_rate > 0 ? ` · ${Number(p.gst_rate)}% GST` : ''}${p.price_source === 'rule' ? ' · from board' : ''}</div></td>
            <td class="right num">${Number(p.stock_qty)}</td>
            <td><button class="badge ${p.in_stock ? 'in-stock' : 'out-of-stock'}" style="border:0;cursor:pointer" data-flag="in_stock" data-id="${p.id}" title="Click to toggle" ${editable ? '' : 'disabled'}>${p.in_stock ? 'In stock' : 'Out of stock'}</button></td>
            <td><button class="badge ${p.is_active ? 'approved' : 'inactive'}" style="border:0;cursor:pointer" data-flag="is_active" data-id="${p.id}" title="Click to toggle" ${editable ? '' : 'disabled'}>${p.is_active ? 'Listed' : 'Hidden'}</button></td>
            <td class="right">${editable ? html`<button class="btn small" data-edit="${p.id}">Edit</button>` : ''}</td></tr>`)}
        </tbody></table></div></div>`);
    const input = $('#search', container);
    input.oninput = () => { search = input.value; draw(); $('#search', container).focus(); };
  }

  on(container, 'click', '#new', () => productForm(null, { categories, cities, availability, hsnCodes, products }, reload));
  on(container, 'click', '#upload', () => uploadDialog({ categories, hsnCodes, products }, reload));
  on(container, 'click', '#categories', () => categoryManager(categories, reload));
  on(container, 'click', '[data-edit]', (_e, el) => productForm(products.find((p) => p.id === el.dataset.edit), { categories, cities, availability, hsnCodes, products }, reload));
  on(container, 'click', '[data-flag]', async (_e, el) => {
    const product = products.find((p) => p.id === el.dataset.id);
    const flag = el.dataset.flag;
    try { await setProductFlags(product.id, { [flag]: !product[flag] }); await reload(); } catch (error) { reportError(error); }
  });

  draw();
}

function productForm(product, { categories, cities, availability, hsnCodes, products = [] }, onSaved) {
  const p = product ?? { in_stock: true, is_active: true, min_order_qty: 1, unit: 'kg', pack_size: 1, pack_unit: 'kg', weight_tolerance_pct: 10 };
  const priceFromBoard = p.price_source === 'rule';
  // A product can be a pack size of another one (one level): offer main products only.
  const mains = products.filter((x) => !x.parent_product_id && x.id !== p.id);
  const hasVariants = products.some((x) => x.parent_product_id === p.id);
  let photoPath = p.photo_path ?? null;
  const listedIn = (cityId) => !availability.some((a) => a.product_id === p.id && a.city_id === cityId && !a.is_available);

  const { el, close } = openModal(html`
    <form id="product-form" class="stack" novalidate>
      <div class="form-grid">
        <label class="field"><span class="label">Name</span><input class="input" name="name" value="${p.name ?? ''}" required maxlength="120"></label>
        <label class="field"><span class="label">SKU</span><input class="input" name="sku" value="${p.sku ?? ''}" required maxlength="40"><span class="hint">Unique code, e.g. VEG-010</span></label>
        <label class="field"><span class="label">Price (₹)</span><input class="input" name="price" type="number" min="0" step="0.01" value="${p.price ?? ''}" required ${priceFromBoard ? 'readonly' : ''}>
          ${priceFromBoard ? html`<span class="hint">Published from the <a href="#pricing">price board</a>; change it there.</span>` : ''}</label>
        <label class="field"><span class="label">Unit</span><input class="input" name="unit" value="${p.unit ?? ''}" required maxlength="20" placeholder="kg, litre, pack…"></label>
        <label class="field"><span class="label">One unit holds</span><div class="row"><input class="input" name="pack_size" type="number" min="0.001" step="any" value="${p.pack_size ?? 1}" required style="width:110px">
          <select class="select" name="pack_unit">${Object.entries(PACK_UNITS).map(([k, v]) => html`<option value="${k}" ${(p.pack_unit ?? 'kg') === k ? 'selected' : ''}>${v}</option>`)}</select></div>
          <span class="hint">1 kg, 15 litre (a tin), 30 pieces (a tray). Per-kg costs on the price board use this.</span></label>
        <label class="field"><span class="label">HSN code</span><select class="select" name="hsn_code"><option value="">— none —</option>
          ${hsnCodes.map((h) => html`<option value="${h.code}" ${h.code === p.hsn_code ? 'selected' : ''}>${h.code} · ${h.description}</option>`)}</select><span class="hint">Printed on invoices; sets the GST rate below when chosen</span></label>
        <label class="field"><span class="label">Minimum order qty</span><input class="input" name="min_order_qty" type="number" min="0.01" step="any" value="${p.min_order_qty ?? 1}" required></label>
        <label class="field"><span class="label">Market price (₹, optional)</span><input class="input" name="market_price" type="number" min="0" step="0.01" value="${p.market_price ?? ''}" ${priceFromBoard ? 'readonly' : ''}><span class="hint">${priceFromBoard ? html`Set from the benchmark when the board publishes (${p.benchmark_label ?? 'no benchmark yet'})` : 'Shown struck through as the "best rate" comparison'}</span></label>
        <label class="field"><span class="label">GST rate (%)</span><select class="select" name="gst_rate">
          ${[0, 5, 12, 18, 28].map((r) => html`<option value="${r}" ${Number(p.gst_rate ?? 0) === r ? 'selected' : ''}>${r}%</option>`)}</select></label>
        <label class="field"><span class="label">Brand (optional)</span><input class="input" name="brand" value="${p.brand ?? ''}" maxlength="60"></label>
        <label class="field"><span class="label">Low-stock alert at</span><input class="input" name="low_stock_threshold" type="number" min="0" step="any" value="${p.low_stock_threshold ?? 0}"><span class="hint">Stock itself is changed under Inventory</span></label>
        <label class="field"><span class="label">Category</span><select class="select" name="category_id" required>
          <option value="">Choose…</option>
          ${categoryOptions(categories).map((c) => html`<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${c.depth ? '— ' : ''}${c.name}</option>`)}</select></label>
        <label class="field"><span class="label">Grade</span><input class="input" name="grade" value="${p.grade ?? ''}" maxlength="20" placeholder="A, B, Premium"></label>
        <label class="field"><span class="label">Origin</span><input class="input" name="origin" value="${p.origin ?? ''}" maxlength="60" placeholder="Madanapalle"></label>
        <label class="field"><span class="label">Veg / non-veg</span><select class="select" name="veg_type"><option value="">Not applicable</option>
          ${Object.entries(VEG_TYPES).map(([k, v]) => html`<option value="${k}" ${p.veg_type === k ? 'selected' : ''}>${v}</option>`)}</select></label>
        <label class="field"><span class="label">Shelf life (days)</span><input class="input" name="shelf_life_days" type="number" min="0" step="1" value="${p.shelf_life_days ?? ''}"></label>
        <label class="field span-2"><span class="label">Storage note</span><input class="input" name="storage_note" value="${p.storage_note ?? ''}" maxlength="120" placeholder="Keep refrigerated"></label>
        <label class="field"><span class="label">Pack size of</span><select class="select" name="parent_product_id" ${hasVariants ? 'disabled' : ''}><option value="">— a product of its own —</option>
          ${mains.map((m) => html`<option value="${m.id}" ${m.id === p.parent_product_id ? 'selected' : ''}>${m.name}</option>`)}</select>
          <span class="hint">${hasVariants ? 'This product has pack sizes of its own.' : 'Makes this a pack size of another product: shown as one card with a pack picker.'}</span></label>
        <label class="field"><span class="label">Pack label</span><input class="input" name="variant_label" value="${p.variant_label ?? ''}" maxlength="40" placeholder="25 kg bag"></label>
        <label class="check"><input type="checkbox" name="sold_by_weight" ${p.sold_by_weight ? 'checked' : ''}> Sold by weight: billed on the packed weight</label>
        <label class="field"><span class="label">Weight tolerance (%)</span><input class="input" name="weight_tolerance_pct" type="number" min="0" max="100" step="0.5" value="${p.weight_tolerance_pct ?? 10}"><span class="hint">How far the packed weight may differ from the order</span></label>
        <label class="field span-2"><span class="label">Description</span><textarea class="textarea" name="description" rows="2" maxlength="500">${p.description ?? ''}</textarea></label>
        <div class="field span-2"><span class="label">Photo</span>
          <div class="row"><div id="preview">${photoPath ? html`<img class="thumb" src="${photoUrl(photoPath)}" alt="">` : html`<div class="thumb-empty">None</div>`}</div>
            <input type="file" id="photo" accept="image/jpeg,image/png,image/webp"></div>
          <span class="hint">JPG, PNG or WebP, up to 5 MB.</span></div>
        <label class="check"><input type="checkbox" name="in_stock" ${p.in_stock ? 'checked' : ''}> In stock</label>
        <label class="check"><input type="checkbox" name="is_active" ${p.is_active ? 'checked' : ''}> Listed in catalogue</label>
        ${cities.length > 1 ? html`<div class="field span-2"><span class="label">Listed in these cities</span>
          <div class="row-wrap">${cities.map((c) => html`<label class="check"><input type="checkbox" data-city="${c.id}" ${listedIn(c.id) ? 'checked' : ''}> ${c.name}</label>`)}</div>
          <span class="hint">Untick a city to hide the product there (customers in that city cannot see or order it).</span></div>` : ''}
      </div>
      <p class="form-error" id="form-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save product</button></div>
    </form>`, { title: product ? 'Edit product' : 'Add product', wide: true });

  // Choosing an HSN code fills in its usual GST rate (still editable).
  $('[name=hsn_code]', el).onchange = (event) => {
    const h = hsnCodes.find((x) => x.code === event.target.value);
    if (h) $('[name=gst_rate]', el).value = String(Number(h.default_gst_rate));
  };

  $('#photo', el).onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      photoPath = await uploadProductPhoto(file);
      mount($('#preview', el), html`<img class="thumb" src="${photoUrl(photoPath)}" alt="">`);
    } catch (error) { reportError(error); event.target.value = ''; }
  };

  $('#product-form', el).onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.checkValidity()) { $('#form-error', el).textContent = 'Please fill in all required fields.'; return; }
    const v = Object.fromEntries(new FormData(form));
    try {
      await withBusy($('button[type="submit"]', form), async () => {
        const saved = await saveProduct({
          ...v, id: product?.id, photo_path: photoPath, price_source: p.price_source,
          in_stock: form.elements.in_stock.checked, is_active: form.elements.is_active.checked,
          sold_by_weight: form.elements.sold_by_weight.checked,
          parent_product_id: form.elements.parent_product_id.disabled ? p.parent_product_id : v.parent_product_id,
        });
        // Per-city listing: only write rows whose tick changed.
        for (const box of form.querySelectorAll('[data-city]')) {
          if (box.checked !== listedIn(box.dataset.city)) await setProductAvailability(saved.id, box.dataset.city, box.checked);
        }
      });
      toast('Product saved', 'success');
      close(); onSaved();
    } catch (error) { $('#form-error', el).textContent = error.message; }
  };
}

function categoryManager(categories, onChanged) {
  const { el, close } = openModal(html`<div id="cats"></div>`, { title: 'Categories' });
  const host = $('#cats', el);
  let list = categories;

  function draw() {
    mount(host, html`
      <p class="muted small">Two levels: a category, or a sub-category under one. Products can sit at either level.</p>
      ${categoryOptions(list).map((c) => html`<div class="line" data-id="${c.id}" style="${c.depth ? 'padding-left:var(--space-5)' : ''}">
        <input class="input small" value="${c.name}" data-name aria-label="Name">
        <select class="select small" data-parent aria-label="Parent" ${list.some((x) => x.parent_id === c.id) ? 'disabled' : ''}><option value="">Top level</option>
          ${list.filter((t) => !t.parent_id && t.id !== c.id).map((t) => html`<option value="${t.id}" ${t.id === c.parent_id ? 'selected' : ''}>under ${t.name}</option>`)}</select>
        <input class="input small num" style="width:80px" type="number" value="${c.sort_order}" data-order aria-label="Sort order">
        <button class="btn small" data-save>Save</button><button class="btn danger small" data-delete>Delete</button></div>`)}
      <form id="add-cat" class="row" style="margin-top:var(--space-4)">
        <input class="input" name="name" placeholder="New category name" required maxlength="60">
        <select class="select" name="parent_id"><option value="">Top level</option>${list.filter((t) => !t.parent_id).map((t) => html`<option value="${t.id}">under ${t.name}</option>`)}</select>
        <button class="btn primary" type="submit">Add</button></form>`);
  }

  async function refresh() { list = await listCategories(); draw(); onChanged(); }

  on(host, 'click', '[data-save]', async (_e, b) => {
    const row = b.closest('[data-id]');
    const parent = $('[data-parent]', row);
    try { await saveCategory({ id: row.dataset.id, name: $('[data-name]', row).value, sort_order: $('[data-order]', row).value, parent_id: parent.disabled ? list.find((c) => c.id === row.dataset.id)?.parent_id : parent.value }); toast('Saved', 'success'); await refresh(); }
    catch (error) { reportError(error); }
  });
  on(host, 'click', '[data-delete]', async (_e, b) => {
    const row = b.closest('[data-id]');
    if (!(await confirmDialog('Delete this category? This only works if no products use it.', { confirmText: 'Delete', danger: true }))) return;
    try { await deleteCategory(row.dataset.id); await refresh(); }
    catch (error) { reportError(/violates|23503|restrict/i.test(error.message) ? new Error('This category still has products. Move them first.') : error); }
  });
  on(host, 'submit', '#add-cat', async (event, form) => {
    event.preventDefault();
    try { await saveCategory({ name: form.elements.name.value, parent_id: form.elements.parent_id.value, sort_order: (list.at(-1)?.sort_order ?? 0) + 10 }); await refresh(); } catch (error) { reportError(error); }
  });
  draw();
}

/** Bulk upload: parse, check every line against the catalogue, show what would happen, then write. */
function uploadDialog({ categories, hsnCodes, products }, onSaved) {
  let prepared = { rows: [], problems: [], created: 0, updated: 0 };
  const { el, close } = openModal(html`
    <div class="stack">
      <p>CSV with a header row. Columns: <code>sku, name, category, price, unit</code> (needed for new products) and any of
        <code>min_order_qty, gst_rate, hsn_code, pack_size, pack_unit, brand, grade, origin, veg_type, shelf_life_days, storage_note,
        market_price, description, low_stock_threshold, in_stock, is_active, sold_by_weight, weight_tolerance_pct, parent_sku, variant_label</code>.
        An existing SKU is updated with just the columns present; a price published from the price board is left alone.</p>
      <label class="field"><span class="label">File</span><input type="file" id="csv-file" accept=".csv,text/csv"></label>
      <div id="csv-preview"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="csv-save" disabled>Save products</button></div>
    </div>`, { title: 'Upload products from CSV', wide: true });

  $('#csv-file', el).onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      prepared = csvToProducts(parseCsv(await readTextFile(file)), { categories, hsnCodes, existing: products });
      mount($('#csv-preview', el), html`
        <p><strong>${prepared.created}</strong> new, <strong>${prepared.updated}</strong> updated${prepared.problems.length ? html`, <strong>${prepared.problems.length}</strong> line${prepared.problems.length === 1 ? '' : 's'} with a problem (skipped)` : ''}.</p>
        ${prepared.problems.length ? html`<ul class="diff">${prepared.problems.slice(0, 15).map((x) => html`<li class="old">${x}</li>`)}</ul>` : ''}`);
      $('#csv-save', el).disabled = prepared.rows.length === 0;
    } catch (error) { reportError(error); }
  };
  $('#csv-save', el).onclick = async () => {
    try {
      const result = await withBusy($('#csv-save', el), () => upsertProducts(prepared.rows));
      toast(`${result.created} added, ${result.updated} updated`, 'success');
      close(); onSaved();
    } catch (error) { reportError(error); }
  };
}
