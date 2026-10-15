// =============================================================================
// csv-import.js — turn a parsed CSV (csv.js parseCsv) into product rows for
// upsertProducts(). Pure, unit-tested; the screen only shows the result.
//
// Columns (header names, any order, case-insensitive):
//   sku*, name*, category* (name, or "Parent › Sub"), price*, unit*,
//   min_order_qty, gst_rate, hsn_code, pack_size, pack_unit, brand, grade,
//   origin, veg_type (veg / non_veg), shelf_life_days, storage_note,
//   market_price, description, low_stock_threshold, in_stock (yes/no),
//   is_active (yes/no), sold_by_weight (yes/no), weight_tolerance_pct,
//   parent_sku (for a pack-size variant), variant_label
// * required for a NEW product; an existing SKU only needs the columns being changed.
// =============================================================================

import { PACK_UNITS, VEG_TYPES } from './config.js';

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/** Category lookup by name or "Parent › Sub" / "Parent > Sub" (case-insensitive). */
export function categoryByName(categories, text) {
  const wanted = String(text ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const last = wanted.split(/\s*(?:›|>)\s*/).pop();
  return categories.find((c) => c.name.toLowerCase() === wanted) ?? categories.find((c) => c.name.toLowerCase() === last) ?? null;
}

/**
 * @param parsed   { headers, rows } from parseCsv
 * @param lookups  { categories: [{id, name, parent_id}], hsnCodes: [{code}], existing: [{id, sku, price_source, parent_product_id}] }
 * @returns { rows: [...product rows], problems: ['line 3: …'], created: n, updated: n }
 */
export function csvToProducts(parsed, { categories = [], hsnCodes = [], existing = [] }) {
  const bySku = new Map(existing.map((p) => [p.sku.toLowerCase(), p]));
  const hsn = new Set(hsnCodes.map((h) => h.code));
  const rows = [];
  const problems = [];
  let created = 0;
  let updated = 0;
  const has = (r, k) => r[k] !== undefined && r[k] !== '';
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const bool = (v) => (YES.has(String(v).toLowerCase()) ? true : NO.has(String(v).toLowerCase()) ? false : null);

  parsed.rows.forEach((r, n) => {
    const line = n + 2;
    const sku = (r.sku ?? '').trim();
    if (!sku) { problems.push(`line ${line}: sku is empty`); return; }
    const current = bySku.get(sku.toLowerCase());
    const row = { sku };
    const fail = (why) => { problems.push(`line ${line} (${sku}): ${why}`); };

    if (has(r, 'name')) row.name = r.name.trim();
    if (has(r, 'category')) {
      const c = categoryByName(categories, r.category);
      if (!c) return fail(`unknown category "${r.category}"`);
      row.category_id = c.id;
    }
    if (has(r, 'price')) {
      const v = num(r.price);
      if (!(v >= 0)) return fail(`price "${r.price}" is not a number`);
      // Rule 15: a board-published price is changed on the board, not by a file.
      if (current?.price_source === 'rule') problems.push(`line ${line} (${sku}): price skipped — published from the price board`);
      else row.price = v;
    }
    if (has(r, 'unit')) row.unit = r.unit.trim();
    for (const [key, min] of [['min_order_qty', 0.01], ['gst_rate', 0], ['pack_size', 0.001], ['market_price', 0], ['low_stock_threshold', 0], ['weight_tolerance_pct', 0], ['shelf_life_days', 0]]) {
      if (has(r, key)) {
        const v = num(r[key]);
        if (v == null || Number.isNaN(v) || v < min) return fail(`${key} "${r[key]}" is not a valid number`);
        row[key] = v;
      }
    }
    if (has(r, 'gst_rate') && ![0, 5, 12, 18, 28].includes(row.gst_rate)) return fail(`gst_rate must be 0, 5, 12, 18 or 28`);
    if (has(r, 'hsn_code')) {
      if (!hsn.has(r.hsn_code.trim())) return fail(`unknown HSN code "${r.hsn_code}"`);
      row.hsn_code = r.hsn_code.trim();
    }
    if (has(r, 'pack_unit')) {
      if (!PACK_UNITS[r.pack_unit.trim()]) return fail(`pack_unit must be one of ${Object.keys(PACK_UNITS).join(', ')}`);
      row.pack_unit = r.pack_unit.trim();
    }
    if (has(r, 'veg_type')) {
      if (!VEG_TYPES[r.veg_type.trim()]) return fail(`veg_type must be veg or non_veg`);
      row.veg_type = r.veg_type.trim();
    }
    for (const key of ['brand', 'grade', 'origin', 'storage_note', 'description', 'variant_label']) {
      if (has(r, key)) row[key] = r[key].trim();
    }
    for (const key of ['in_stock', 'is_active', 'sold_by_weight']) {
      if (has(r, key)) {
        const v = bool(r[key]);
        if (v == null) return fail(`${key} must be yes or no`);
        row[key] = v;
      }
    }
    if (has(r, 'parent_sku')) {
      const parent = bySku.get(r.parent_sku.trim().toLowerCase());
      if (!parent) return fail(`parent_sku "${r.parent_sku}" is not an existing product`);
      if (parent.parent_product_id) return fail(`parent_sku "${r.parent_sku}" is itself a variant`);
      row.parent_product_id = parent.id;
    }

    if (!current) {
      const missing = ['name', 'category_id', 'price', 'unit'].filter((k) => row[k] === undefined);
      if (missing.length) return fail(`new product needs ${missing.map((m) => m.replace('_id', '')).join(', ')}`);
      created += 1;
    } else {
      row.id = current.id;
      updated += 1;
    }
    rows.push(row);
  });
  return { rows, problems, created, updated };
}
