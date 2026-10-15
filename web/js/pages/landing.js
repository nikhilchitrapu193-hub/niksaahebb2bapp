// =============================================================================
// landing.js — fills the public home page with live categories and products.
// Logged-out visitors are allowed to READ listed products (RLS policy
// products_public_select); everything else needs a login.
// =============================================================================

import { html, mount, $, on, formatINR } from '../core/ui.js';
import { listCategories, listProducts, photoUrl, checkPincode } from '../core/api.js';
import { categoryTree } from '../core/catalogue.js';

async function fillCatalogue() {
  const [categories, products] = await Promise.all([listCategories(), listProducts()]);
  // Tiles are the top-level categories; a product in a sub-category counts under its parent.
  const countBy = {};
  for (const p of products) countBy[p.category_id] = (countBy[p.category_id] ?? 0) + 1;
  const tops = categoryTree(categories.filter((c) => c.is_active !== false))
    .map((t) => ({ ...t, count: (countBy[t.id] ?? 0) + t.children.reduce((n, c) => n + (countBy[c.id] ?? 0), 0) }))
    .filter((t) => t.count > 0);

  mount($('#categories'), html`${tops.map((c) => html`
    <a class="category-tile" href="restaurant/login.html">
      <strong>${c.name}</strong><span>${c.count} products</span>
    </a>`)}`);

  const featured = products.filter((p) => p.in_stock && p.stock_qty > 0 && !p.parent_product_id).slice(0, 8);
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
          ${saving ? html`<div class="best-rate">Best rate · save ${Math.round((1 - p.price / p.market_price) * 100)}%${p.benchmark_label ? html` <span class="muted">vs ${p.benchmark_label}</span>` : ''}</div>` : ''}
          <div class="product-actions"><a class="btn block" href="restaurant/login.html">Sign in to order</a></div>
        </div>
      </article>`;
  })}`);
}

fillCatalogue().catch((error) => {
  console.error(error);
  mount($('#categories'), html`<p class="muted">Catalogue is unavailable right now. Please try again later.</p>`);
});

// ---------- "Do you deliver here?" ------------------------------------------
// Logged-out visitors may call check_pincode(); it returns only yes/no + city.
on(document, 'submit', '#pin-check', async (event, form) => {
  event.preventDefault();
  const input = $('#pin-input', form);
  const result = $('#pin-result', form);
  result.className = 'small';
  if (!input.checkValidity() || !input.value) { result.textContent = 'Enter a 6-digit pin code.'; return; }
  try {
    const answer = await checkPincode(input.value);
    result.className = `small ${answer.delivers ? 'ok' : 'no'}`;
    result.textContent = answer.delivers
      ? `Yes — we deliver to ${input.value}${answer.area ? ` (${answer.area})` : ''}, ${answer.city}. Register to start ordering.`
      : `Not yet in ${input.value}. Register anyway and we will tell you when we open there.`;
  } catch (error) {
    console.error(error);
    result.textContent = 'Could not check right now. Please try again.';
  }
});
