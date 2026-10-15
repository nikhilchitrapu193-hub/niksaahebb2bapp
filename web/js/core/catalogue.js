// =============================================================================
// catalogue.js — pure helpers for the two-level category tree, product
// variants and the customer catalogue's sort / filters. No DOM, no network;
// used by the admin product screens and the customer app, unit-tested.
// =============================================================================

/** Top-level categories in order, each with its `children` (also in order). */
export function categoryTree(categories) {
  const byOrder = (a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name);
  const tops = categories.filter((c) => !c.parent_id).sort(byOrder);
  return tops.map((t) => ({ ...t, children: categories.filter((c) => c.parent_id === t.id).sort(byOrder) }));
}

/** Flat list in tree order with a `depth` (0 or 1) and a display `path` ("Vegetables › Leafy greens"). */
export function categoryOptions(categories) {
  const out = [];
  for (const t of categoryTree(categories)) {
    out.push({ ...t, depth: 0, path: t.name });
    for (const c of t.children) out.push({ ...c, depth: 1, path: `${t.name} › ${c.name}` });
  }
  return out;
}

/** The category itself plus its sub-categories (ids), for "show everything under Vegetables". */
export function categoryFamily(categories, categoryId) {
  if (!categoryId) return null;
  return [categoryId, ...categories.filter((c) => c.parent_id === categoryId).map((c) => c.id)];
}

/**
 * Group pack-size variants under their main product. Returns one entry per
 * main product: { main, variants: [main, ...packs] } in the order given.
 * Variants whose parent is not in the list are shown on their own.
 */
export function groupVariants(products) {
  const ids = new Set(products.map((p) => p.id));
  const groups = new Map();
  for (const p of products) {
    const key = p.parent_product_id && ids.has(p.parent_product_id) ? p.parent_product_id : p.id;
    if (!groups.has(key)) groups.set(key, { main: null, variants: [] });
    const g = groups.get(key);
    if (key === p.id) g.main = p; else g.variants.push(p);
  }
  return [...groups.values()].filter((g) => g.main).map((g) => ({ main: g.main, variants: [g.main, ...g.variants] }));
}

/**
 * Filter and sort the catalogue.
 * options: { search, categoryId, categories, brand, vegType, inStockOnly, sort: 'name' | 'price_asc' | 'price_desc' }
 */
export function filterProducts(products, { search = '', categoryId = '', categories = [], brand = '', vegType = '', inStockOnly = false, sort = 'name' } = {}) {
  const term = search.trim().toLowerCase();
  const family = categoryFamily(categories, categoryId);
  const list = products.filter((p) =>
    (!family || family.includes(p.category_id)) &&
    (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term) || (p.brand ?? '').toLowerCase().includes(term)) &&
    (!brand || (p.brand ?? '') === brand) &&
    (!vegType || p.veg_type === vegType) &&
    (!inStockOnly || (p.in_stock && Number(p.stock_qty) > 0)));
  const cmp = sort === 'price_asc' ? (a, b) => Number(a.price) - Number(b.price)
    : sort === 'price_desc' ? (a, b) => Number(b.price) - Number(a.price)
    : (a, b) => a.name.localeCompare(b.name);
  return list.sort(cmp);
}

/** Distinct brands in the list, sorted. */
export function brandsOf(products) {
  return [...new Set(products.map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * Apply a customer's price list to the loaded products: replaces `price`
 * and keeps the published one as `list_price` so the screen can say
 * "your price". Returns a new array.
 */
export function applyPriceList(products, entries) {
  const mine = new Map((entries ?? []).map((e) => [e.product_id, Number(e.price)]));
  return products.map((p) => (mine.has(p.id) ? { ...p, list_price: Number(p.price), price: mine.get(p.id) } : p));
}
