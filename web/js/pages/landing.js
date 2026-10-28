// =============================================================================
// landing.js — fills the public home page with live categories and products.
// Logged-out visitors are allowed to READ listed products (RLS policy
// products_public_select); everything else needs a login.
// =============================================================================

import { html, mount, $, on, formatINR } from '../core/ui.js';
import { listCategories, listProducts, photoUrl, checkPincode, listHelpArticles, listSectors, listContentPages } from '../core/api.js';
import { categoryTree } from '../core/catalogue.js';
import { fillFooter } from './page.js';

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

// ---------- FAQ, footer and SEO from the database (migrations 018 / 019) ------
// help_articles with audience = 'public' replace the built-in FAQ; the footer
// shows the published content pages and the support channels; the SEO title /
// description come from Settings → Website. All fail quietly: the static text
// in index.html stays if the database is away.
async function fillHelp() {
  const articles = await listHelpArticles('public').catch(() => []);
  const publicOnes = articles.filter((a) => a.audience === 'public');
  if (publicOnes.length) {
    mount($('#faq-list'), html`${publicOnes.map((a) => html`<details><summary>${a.title}</summary>${String(a.body).split(/\n\s*\n/).filter((p) => p.trim()).map((p) => html`<p>${p.trim()}</p>`)}</details>`)}`);
  }
  // Who we serve (migration 020): one tile per live sector that can sign up, linking to its page when one is published.
  const [sectors, pages] = await Promise.all([listSectors().catch(() => []), listContentPages().catch(() => [])]);
  const tiles = sectors.filter((x) => x.is_active && x.can_self_register).map((x) => ({ ...x, page: pages.find((p) => p.slug === `sector-${x.code}` && p.is_published) }));
  const host = $('#sector-tiles');
  if (host && tiles.length) {
    mount(host, html`${tiles.map((x) => html`<article class="card card-pad"><h3>${x.name}</h3><p class="muted">${x.description ?? ''}</p>
      <div class="row-wrap" style="margin-top:var(--space-3)">${x.page ? html`<a class="btn" href="page.html?slug=${x.page.slug}">Learn more</a>` : ''}<a class="btn primary" href="restaurant/login.html#register&sector=${x.code}">Register</a></div></article>`)}`);
  } else if (host) { host.closest('section')?.remove(); }
  const ch = await fillFooter();
  if (ch?.seo_title) document.title = ch.seo_title;
  if (ch?.seo_description) document.querySelector('meta[name="description"]')?.setAttribute('content', ch.seo_description);
}
fillHelp().catch(console.error);
