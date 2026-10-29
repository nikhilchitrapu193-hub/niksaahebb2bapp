// =============================================================================
// bulk-order.js — "Upload your order as a CSV" (migration 021 batch; no schema).
// Turns a parsed CSV (csv.js parseCsv) into cart lines against the catalogue
// the customer can see. Pure and unit-tested; the screen only shows the result.
//
// Columns (header names, any order, case-insensitive): sku or product (name),
// quantity (or qty). A line below the product's minimum is raised to it and
// reported; an unknown SKU / name is reported and skipped.
// =============================================================================

const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * @param parsed   { headers, rows } from parseCsv (rows are objects keyed by header)
 * @param products the customer's catalogue [{ id, sku, name, min_order_qty, in_stock, is_active }]
 * @returns { lines: [{ product_id, quantity, name }], problems: ['line 3: …'] }
 */
export function csvToCartLines(parsed, products) {
  const bySku = new Map(products.map((p) => [norm(p.sku), p]));
  const byName = new Map(products.map((p) => [norm(p.name), p]));
  const lines = new Map();
  const problems = [];
  const headers = (parsed.headers ?? []).map(norm);
  const skuKey = parsed.headers?.[headers.indexOf('sku')];
  const nameKey = parsed.headers?.[headers.findIndex((h) => h === 'product' || h === 'name' || h === 'item')];
  const qtyKey = parsed.headers?.[headers.findIndex((h) => h === 'quantity' || h === 'qty')];
  if (!qtyKey || (!skuKey && !nameKey)) return { lines: [], problems: ['The file needs a "sku" (or "product") column and a "quantity" column.'] };

  parsed.rows.forEach((row, i) => {
    const line = i + 2;
    const sku = skuKey ? norm(row[skuKey]) : '';
    const name = nameKey ? norm(row[nameKey]) : '';
    const product = (sku && bySku.get(sku)) || (name && byName.get(name)) || null;
    if (!product) { problems.push(`line ${line}: "${row[skuKey] || row[nameKey] || ''}" is not in the catalogue`); return; }
    if (product.is_active === false || product.in_stock === false) { problems.push(`line ${line}: ${product.name} is not available right now`); return; }
    let qty = Number(String(row[qtyKey]).replace(/[^0-9.]/g, ''));
    if (!(qty > 0)) { problems.push(`line ${line}: quantity for ${product.name} must be a number above 0`); return; }
    const min = Number(product.min_order_qty) || 0;
    if (qty < min) { problems.push(`line ${line}: ${product.name} raised to its minimum of ${min}`); qty = min; }
    lines.set(product.id, { product_id: product.id, quantity: (lines.get(product.id)?.quantity ?? 0) + qty, name: product.name });
  });
  return { lines: [...lines.values()], problems };
}

/** The template customers download: header + two example rows. */
export function bulkOrderTemplate(products) {
  const sample = products.slice(0, 2);
  return ['sku,product,quantity', ...sample.map((p) => `${p.sku},${p.name.includes(',') ? `"${p.name}"` : p.name},${Number(p.min_order_qty) || 1}`)].join('\r\n');
}
