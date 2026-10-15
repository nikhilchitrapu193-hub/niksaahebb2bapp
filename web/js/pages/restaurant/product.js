// =============================================================================
// product.js — one product's page (#product/<id>): photo, description, grade,
// origin, shelf life, storage, GST, minimum order, pack sizes, benchmark and
// add to cart. Everything comes from the catalogue already loaded by main.js.
// =============================================================================

import { html, mount, $, on, formatINR, formatDate } from '../../core/ui.js';
import { photoUrl } from '../../core/api.js';
import { VEG_TYPES } from '../../core/config.js';
import { displayPrice, isUnavailable } from './catalogue.js';
import { getQty, setQty } from './cart.js';

export function renderProduct(container, state, productId) {
  const product = state.byId[productId];
  if (!product) {
    mount(container, html`<div class="empty"><strong>Product not found</strong><a href="#catalogue">Back to the catalogue</a></div>`);
    return;
  }
  const main = product.parent_product_id ? state.byId[product.parent_product_id] ?? product : product;
  const packs = [main, ...state.products.filter((p) => p.parent_product_id === main.id)];
  let chosen = product;

  function draw() {
    // A pack size shows its own price, SKU and stock; descriptive details come from the main product when the pack has none.
    const p = { ...chosen };
    for (const key of ['description', 'grade', 'origin', 'veg_type', 'shelf_life_days', 'storage_note', 'brand', 'hsn_code', 'benchmark_label', 'market_price', 'benchmark_date']) {
      if (p[key] == null || p[key] === '') p[key] = main[key];
    }
    const qty = getQty(p.id);
    const unavailable = isUnavailable(p);
    const shown = displayPrice(p, state.settings);
    const url = photoUrl(p.photo_path ?? main.photo_path);
    const saving = p.market_price && Number(p.market_price) > Number(p.price);
    mount(container, html`
      <p><a href="#catalogue">← Catalogue</a></p>
      <div class="product-page">
        <div class="product-photo large">${url ? html`<img src="${url}" alt="${p.name}">` : '🥬'}</div>
        <div class="stack">
          <div><h1>${main.name}</h1>
            <div class="muted">${p.brand ? html`${p.brand} · ` : ''}${p.categories?.name ?? ''}${p.veg_type ? html` · ${VEG_TYPES[p.veg_type]}` : ''}</div></div>
          ${packs.length > 1 ? html`<div class="row-wrap">${packs.map((v) => html`<button class="chip" data-pack="${v.id}" aria-pressed="${String(v.id === p.id)}">${v.variant_label ?? `per ${v.unit}`}</button>`)}</div>` : ''}
          <div class="product-price large">${formatINR(shown.amount)} <small>/ ${p.unit}${p.gst_rate > 0 ? (shown.inclGst ? ` incl. ${Number(p.gst_rate)}% GST` : ` + ${Number(p.gst_rate)}% GST`) : ''}</small>
            ${p.list_price != null && Number(p.list_price) !== Number(p.price) ? html`<span class="price-strike">${formatINR(p.list_price)}</span> <span class="best-rate">Your price</span>`
              : saving ? html`<span class="price-strike">${formatINR(p.market_price)}</span> <span class="best-rate">Best rate${p.benchmark_label ? ` vs ${p.benchmark_label}` : ''}</span>` : ''}</div>
          ${p.description ? html`<p>${p.description}</p>` : ''}
          <dl class="kv compact">
            <dt>SKU</dt><dd>${p.sku}</dd>
            <dt>Minimum order</dt><dd>${Number(p.min_order_qty)} ${p.unit}</dd>
            ${p.pack_size && p.pack_unit ? html`<dt>One ${p.unit} holds</dt><dd>${Number(p.pack_size)} ${p.pack_unit}</dd>` : ''}
            ${p.grade ? html`<dt>Grade</dt><dd>${p.grade}</dd>` : ''}
            ${p.origin ? html`<dt>Origin</dt><dd>${p.origin}</dd>` : ''}
            ${p.shelf_life_days != null ? html`<dt>Shelf life</dt><dd>${p.shelf_life_days} day${p.shelf_life_days === 1 ? '' : 's'}</dd>` : ''}
            ${p.storage_note ? html`<dt>Storage</dt><dd>${p.storage_note}</dd>` : ''}
            ${p.hsn_code ? html`<dt>HSN</dt><dd>${p.hsn_code}</dd>` : ''}
            ${p.sold_by_weight ? html`<dt>Billing</dt><dd>Weighed at packing; billed on the actual weight (within ${Number(p.weight_tolerance_pct)}%)</dd>` : ''}
            ${p.benchmark_date ? html`<dt>Market rate</dt><dd>${formatINR(p.market_price)} · ${p.benchmark_label ?? formatDate(p.benchmark_date)}</dd>` : ''}
          </dl>
          <div class="product-actions">
            ${unavailable ? html`<span class="badge out-of-stock">Out of stock</span>`
              : qty > 0 ? html`<div class="stepper">
                  <button data-step="-1" aria-label="Decrease">−</button>
                  <input type="number" min="0" step="any" value="${qty}" id="qty" aria-label="Quantity">
                  <button data-step="1" aria-label="Increase">+</button></div>
                  <a class="btn" href="#catalogue">Continue shopping</a>`
              : html`<button class="btn primary" id="add">Add ${Number(p.min_order_qty)} ${p.unit} to cart</button>`}
          </div>
        </div>
      </div>`);
  }

  on(container, 'click', '[data-pack]', (_e, el) => { chosen = state.byId[el.dataset.pack] ?? chosen; draw(); });
  on(container, 'click', '#add', () => { setQty(chosen.id, getQty(chosen.id) + Number(chosen.min_order_qty)); draw(); });
  on(container, 'click', '[data-step]', (_e, el) => {
    const next = getQty(chosen.id) + Number(el.dataset.step);
    setQty(chosen.id, next < Number(chosen.min_order_qty) ? 0 : next);
    draw();
  });
  on(container, 'change', '#qty', (_e, el) => {
    const value = Number(el.value);
    setQty(chosen.id, value > 0 ? Math.max(value, Number(chosen.min_order_qty)) : 0);
    draw();
  });
  draw();
}
