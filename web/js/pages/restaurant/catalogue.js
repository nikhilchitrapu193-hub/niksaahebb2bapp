// =============================================================================
// catalogue.js — browse products: search, category filter, add to cart.
// =============================================================================

import { html, mount, $, on, formatINR } from '../../core/ui.js';
import { photoUrl } from '../../core/api.js';
import { getQty, setQty } from './cart.js';

/** state: { products, categories } — loaded once by main.js. */
export function renderCatalogue(container, state) {
  let search = '';
  let categoryId = '';

  mount(container, html`
    <div class="page-head"><div><h1>Catalogue</h1><p>Wholesale prices. Minimum order quantities apply.</p></div></div>
    <div class="toolbar">
      <input class="input search" type="search" id="search" placeholder="Search products…" aria-label="Search products">
    </div>
    <div class="chips" id="chips" style="margin-bottom:var(--space-4)"></div>
    <div id="grid"></div>`);

  const chips = $('#chips', container);
  const grid = $('#grid', container);

  function drawChips() {
    mount(chips, html`
      <button class="chip" data-cat="" aria-pressed="${String(categoryId === '')}">All</button>
      ${state.categories.map((c) => html`<button class="chip" data-cat="${c.id}" aria-pressed="${String(categoryId === c.id)}">${c.name}</button>`)}`);
  }

  function drawGrid() {
    const term = search.trim().toLowerCase();
    const visible = state.products.filter((p) =>
      (!categoryId || p.category_id === categoryId) &&
      (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)));

    if (!visible.length) {
      mount(grid, html`<div class="empty"><strong>No products found</strong>Try a different search or category.</div>`);
      return;
    }
    mount(grid, html`<div class="product-grid">${visible.map(productCard)}</div>`);
  }

  on(container, 'input', '#search', (_e, el) => { search = el.value; drawGrid(); });
  on(container, 'click', '.chip', (_e, el) => { categoryId = el.dataset.cat; drawChips(); drawGrid(); });

  on(container, 'click', '[data-add]', (_e, el) => {
    const product = state.products.find((p) => p.id === el.dataset.add);
    setQty(product.id, getQty(product.id) + product.min_order_qty);
    drawGrid();
  });
  on(container, 'click', '[data-step]', (_e, el) => {
    const product = state.products.find((p) => p.id === el.dataset.id);
    const next = getQty(product.id) + Number(el.dataset.step);
    // Going below the minimum removes the line rather than leaving an invalid quantity.
    setQty(product.id, next < product.min_order_qty ? 0 : next);
    drawGrid();
  });
  on(container, 'change', '[data-qty]', (_e, el) => {
    const product = state.products.find((p) => p.id === el.dataset.qty);
    const value = Number(el.value);
    setQty(product.id, value > 0 ? Math.max(value, product.min_order_qty) : 0);
    drawGrid();
  });

  drawChips();
  drawGrid();
}

/** True when the product cannot be ordered right now. */
export function isUnavailable(p) { return !p.in_stock || Number(p.stock_qty) <= 0; }

function productCard(p) {
  const qty = getQty(p.id);
  const unavailable = isUnavailable(p);
  const lowStock = !unavailable && Number(p.stock_qty) <= Number(p.low_stock_threshold);
  const saving = p.market_price && Number(p.market_price) > Number(p.price);
  const url = photoUrl(p.photo_path);
  return html`
    <article class="card product-card ${unavailable ? 'unavailable' : ''}">
      <div class="product-photo">${url ? html`<img src="${url}" alt="${p.name}" loading="lazy">` : '🥬'}</div>
      <div class="product-body">
        <div class="product-name">${p.name}</div>
        <div class="muted small">${p.brand ? html`${p.brand} · ` : ''}${p.categories?.name ?? ''} · Min ${Number(p.min_order_qty)} ${p.unit}</div>
        <div class="product-price">${formatINR(p.price)} <small>/ ${p.unit}</small>
          ${saving ? html`<span class="price-strike">${formatINR(p.market_price)}</span>` : ''}</div>
        ${saving ? html`<div class="best-rate">Best rate · save ${Math.round((1 - p.price / p.market_price) * 100)}%</div>` : ''}
        ${lowStock ? html`<div class="tiny" style="color:var(--accent);font-weight:600">Only ${Number(p.stock_qty)} ${p.unit} left</div>` : ''}
        ${p.gst_rate > 0 ? html`<div class="muted tiny">+ ${Number(p.gst_rate)}% GST</div>` : ''}
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
