// =============================================================================
// landing.js — fills the public home page with live categories and products.
// Logged-out visitors are allowed to READ listed products (RLS policy
// products_public_select); everything else needs a login.
// =============================================================================

import { html, mount, $, formatINR } from '../core/ui.js';
import { listCategories, listProducts, photoUrl } from '../core/api.js';

async function fillCatalogue() {
  const [categories, products] = await Promise.all([listCategories(), listProducts()]);
  const countBy = {};
  for (const p of products) countBy[p.category_id] = (countBy[p.category_id] ?? 0) + 1;

  mount($('#categories'), html`${categories.map((c) => html`
    <a class="category-tile" href="restaurant/login.html">
      <strong>${c.name}</strong><span>${countBy[c.id] ?? 0} products</span>
    </a>`)}`);

  const featured = products.filter((p) => p.in_stock && p.stock_qty > 0).slice(0, 8);
  mount($('#featured'), html`${featured.map((p) => {
    const url = photoUrl(p.photo_path);
    const saving = p.market_price && p.market_price > p.price;
    return html`
      <article class="card product-card">
        <div class="product-photo">${url ? html`<img src="${url}" alt="${p.name}" loading="lazy">` : '🥬'}</div>
        <div class="product-body">
          <div class="product-name">${p.name}</div>
          <div class="muted small">${p.brand ? html`${p.brand} · ` : ''}min ${Number(p.min_order_qty)} ${p.unit}</div>
          <div class="product-price">${formatINR(p.price)} <small>/ ${p.unit}</small>
            ${saving ? html`<span class="price-strike">${formatINR(p.market_price)}</span>` : ''}</div>
          ${saving ? html`<div class="best-rate">Best rate · save ${Math.round((1 - p.price / p.market_price) * 100)}%</div>` : ''}
          <div class="product-actions"><a class="btn block" href="restaurant/login.html">Sign in to order</a></div>
        </div>
      </article>`;
  })}`);
}

fillCatalogue().catch((error) => {
  console.error(error);
  mount($('#categories'), html`<p class="muted">Catalogue is unavailable right now. Please try again later.</p>`);
});
