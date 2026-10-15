// =============================================================================
// catalogue.js — browse products: search, category and sub-category chips,
// sort and filters (brand, veg / non-veg, in stock), one card per product
// with a pack-size picker for variants, add to cart. The card's name links to
// the product page (#product/<id>). Prices already carry the customer's price
// list (main.js applied it); a different published price is shown struck through.
// =============================================================================

import { html, mount, $, on, formatINR } from '../../core/ui.js';
import { photoUrl } from '../../core/api.js';
import { CATALOGUE_SORTS, VEG_TYPES } from '../../core/config.js';
import { categoryTree, filterProducts, groupVariants, brandsOf } from '../../core/catalogue.js';
import { getQty, setQty } from './cart.js';

/**
 * Price as the catalogue shows it: excluding GST (default) or including it
 * when the company setting says so. Pure.
 */
export function displayPrice(product, settings) {
  const price = Number(product.price);
  const incl = Boolean(settings?.show_prices_incl_gst);
  return { amount: incl ? Math.round(price * (1 + Number(product.gst_rate || 0) / 100) * 100) / 100 : price, inclGst: incl };
}

/** True when the product cannot be ordered right now. */
export function isUnavailable(p) { return !p.in_stock || Number(p.stock_qty) <= 0; }

/** state: { products, categories, settings } — loaded once by main.js. */
export function renderCatalogue(container, state) {
  const f = { search: '', categoryId: '', brand: '', vegType: '', inStockOnly: false, sort: 'name' };
  const chosenPack = {};   // main product id → variant id picked on the card

  mount(container, html`
    <div class="page-head"><div><h1>Catalogue</h1><p>Wholesale prices. Minimum order quantities apply.</p></div></div>
    <div class="toolbar">
      <input class="input search" type="search" id="search" placeholder="Search products or brands…" aria-label="Search products">
      <select class="select" id="sort" aria-label="Sort">${Object.entries(CATALOGUE_SORTS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select>
      <select class="select" id="brand" aria-label="Brand"><option value="">All brands</option>${brandsOf(state.products).map((b) => html`<option value="${b}">${b}</option>`)}</select>
      <select class="select" id="veg" aria-label="Veg or non-veg"><option value="">Veg &amp; non-veg</option>${Object.entries(VEG_TYPES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
      <label class="check small"><input type="checkbox" id="in-stock"> In stock only</label>
    </div>
    <div class="chips" id="chips" style="margin-bottom:var(--space-2)"></div>
    <div class="chips" id="sub-chips" style="margin-bottom:var(--space-4)"></div>
    <div id="grid"></div>`);

  const chips = $('#chips', container);
  const subChips = $('#sub-chips', container);
  const grid = $('#grid', container);
  const tree = categoryTree(state.categories.filter((c) => c.is_active !== false));

  function drawChips() {
    const parent = tree.find((t) => t.id === f.categoryId) ?? tree.find((t) => t.children.some((c) => c.id === f.categoryId));
    mount(chips, html`
      <button class="chip" data-cat="" aria-pressed="${String(f.categoryId === '')}">All</button>
      ${tree.map((c) => html`<button class="chip" data-cat="${c.id}" aria-pressed="${String(c.id === f.categoryId || c.id === parent?.id)}">${c.name}</button>`)}`);
    mount(subChips, parent && parent.children.length ? html`
      <button class="chip" data-cat="${parent.id}" aria-pressed="${String(f.categoryId === parent.id)}">All ${parent.name}</button>
      ${parent.children.map((c) => html`<button class="chip" data-cat="${c.id}" aria-pressed="${String(c.id === f.categoryId)}">${c.name}</button>`)}` : '');
  }

  function drawGrid() {
    const visible = filterProducts(state.products, { ...f, categories: state.categories });
    if (!visible.length) {
      mount(grid, html`<div class="empty"><strong>No products found</strong>Try a different search, category or filter.</div>`);
      return;
    }
    mount(grid, html`<div class="product-grid">${groupVariants(visible).map((g) => productCard(g, state.settings, chosenPack))}</div>`);
  }

  on(container, 'input', '#search', (_e, el) => { f.search = el.value; drawGrid(); });
  on(container, 'change', '#sort', (_e, el) => { f.sort = el.value; drawGrid(); });
  on(container, 'change', '#brand', (_e, el) => { f.brand = el.value; drawGrid(); });
  on(container, 'change', '#veg', (_e, el) => { f.vegType = el.value; drawGrid(); });
  on(container, 'change', '#in-stock', (_e, el) => { f.inStockOnly = el.checked; drawGrid(); });
  on(container, 'click', '.chip', (_e, el) => { f.categoryId = el.dataset.cat; drawChips(); drawGrid(); });
  on(container, 'change', '[data-pack]', (_e, el) => { chosenPack[el.dataset.pack] = el.value; drawGrid(); });

  on(container, 'click', '[data-add]', (_e, el) => {
    const product = state.byId[el.dataset.add];
    setQty(product.id, getQty(product.id) + Number(product.min_order_qty));
    drawGrid();
  });
  on(container, 'click', '[data-step]', (_e, el) => {
    const product = state.byId[el.dataset.id];
    const next = getQty(product.id) + Number(el.dataset.step);
    // Going below the minimum removes the line rather than leaving an invalid quantity.
    setQty(product.id, next < Number(product.min_order_qty) ? 0 : next);
    drawGrid();
  });
  on(container, 'change', '[data-qty]', (_e, el) => {
    const product = state.byId[el.dataset.qty];
    const value = Number(el.value);
    setQty(product.id, value > 0 ? Math.max(value, Number(product.min_order_qty)) : 0);
    drawGrid();
  });

  drawChips();
  drawGrid();
}

/** One card per main product; `group.variants` are the pack sizes (main first). */
function productCard(group, settings, chosenPack) {
  const p = group.variants.find((v) => v.id === chosenPack[group.main.id]) ?? group.main;
  const qty = getQty(p.id);
  const unavailable = isUnavailable(p);
  const lowStock = !unavailable && Number(p.stock_qty) <= Number(p.low_stock_threshold);
  const shown = displayPrice(p, settings);
  const saving = p.market_price && Number(p.market_price) > Number(p.price);
  const url = photoUrl(p.photo_path ?? group.main.photo_path);
  return html`
    <article class="card product-card ${unavailable ? 'unavailable' : ''}">
      <a class="product-photo" href="#product/${p.id}">${url ? html`<img src="${url}" alt="${p.name}" loading="lazy">` : '🥬'}</a>
      <div class="product-body">
        <a class="product-name" href="#product/${p.id}">${group.main.name}</a>
        <div class="muted small">${p.brand ? html`${p.brand} · ` : ''}${p.categories?.name ?? ''}${p.grade ? html` · Grade ${p.grade}` : ''}${p.origin ? html` · ${p.origin}` : ''}</div>
        ${group.variants.length > 1 ? html`<select class="select small" data-pack="${group.main.id}" aria-label="Pack size">
          ${group.variants.map((v) => html`<option value="${v.id}" ${v.id === p.id ? 'selected' : ''}>${v.variant_label ?? `per ${v.unit}`} · ${formatINR(v.price)}</option>`)}</select>` : ''}
        <div class="product-price">${formatINR(shown.amount)} <small>/ ${p.unit}</small>
          ${p.list_price != null && Number(p.list_price) !== Number(p.price) ? html`<span class="price-strike" title="Published price">${formatINR(p.list_price)}</span>`
            : saving ? html`<span class="price-strike" title="${p.benchmark_label ?? 'Market rate'}">${formatINR(p.market_price)}</span>` : ''}</div>
        ${p.list_price != null && Number(p.list_price) !== Number(p.price) ? html`<div class="best-rate">Your price</div>`
          : saving ? html`<div class="best-rate">Best rate · save ${Math.round((1 - p.price / p.market_price) * 100)}%${p.benchmark_label ? html` <span class="muted">vs ${p.benchmark_label}</span>` : ''}</div>` : ''}
        <div class="muted tiny">Min ${Number(p.min_order_qty)} ${p.unit}${p.sold_by_weight ? ' · billed on packed weight' : ''}${p.gst_rate > 0 ? (shown.inclGst ? ` · incl. ${Number(p.gst_rate)}% GST` : ` · + ${Number(p.gst_rate)}% GST`) : ''}</div>
        ${lowStock ? html`<div class="tiny" style="color:var(--accent);font-weight:600">Only ${Number(p.stock_qty)} ${p.unit} left</div>` : ''}
        <div class="product-actions">
          ${unavailable
            ? html`<span class="badge out-of-stock">Out of stock</span>`
            : qty > 0
              ? html`<div class="stepper">
                  <button data-step="-1" data-id="${p.id}" aria-label="Decrease">−</button>
                  <input type="number" min="0" step="any" value="${qty}" data-qty="${p.id}" aria-label="Quantity">
                  <button data-step="1" data-id="${p.id}" aria-label="Increase">+</button>
                </div>`
              : html`<button class="btn primary block" data-add="${p.id}">Add</button>`}
        </div>
      </div>
    </article>`;
}
