// =============================================================================
// pricing.js — the pricing formula, in the browser.
//
// This is a line-for-line mirror of compute_price_from() in
// supabase/migrations/20261015000004_pricing_engine.sql. The database is the
// source of truth (apply_prices recomputes server-side before writing); this
// copy exists so the price board can show a new number the instant someone
// edits a cost or a markup, without a round trip. tests/unit.test.js feeds
// both the same inputs (security_test.sql T30) — change both or neither.
//
// Pure functions only: no DOM, no network.
// =============================================================================

/** Number or null (empty strings and undefined become null). */
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** Round to 2 or 4 decimals without the usual floating-point surprises. */
export const round2 = (v) => (v == null ? null : Math.round((v + Number.EPSILON) * 100) / 100);
const round4 = (v) => (v == null ? null : Math.round((v + Number.EPSILON) * 10000) / 10000);

/** Round a price to a step (₹0.50, ₹1, ₹5): 'nearest' (half up) or 'up'. */
export function roundPrice(value, step, mode) {
  if (value == null) return null;
  const s = num(step);
  if (!s || s <= 0) return round2(value);
  const n = value / s;
  // Nudge by EPSILON so 33.15 / 0.5 = 66.3 rounds the same way as in SQL.
  const k = mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n + 1e-9);
  return round2(k * s);
}

/** Weight of one selling unit in kg (litres count as kg); null for pieces. */
export function weightKg({ pack_size, pack_unit }) {
  const size = num(pack_size);
  if (size == null) return null;
  if (pack_unit === 'kg' || pack_unit === 'l') return size;
  if (pack_unit === 'g' || pack_unit === 'ml') return size / 1000;
  return null;
}

/**
 * The formula. `i` is the merged inputs object the database returns from
 * price_board / compute_price (or anything with the same keys).
 *
 * Returns { pricing_mode, cost_basis, landed_cost, raw_price, suggested_price,
 *           capped, margin_amount, margin_pct, markup_effective_pct, flags }.
 */
export function computePrice(i) {
  const mode = i.pricing_mode || 'rule';
  const method = i.cost_method || 'weighted_avg_30d';
  const kg = num(i.weight_kg);
  const bm = num(i.benchmark_price);
  const cap = num(i.benchmark_cap_pct);
  const flags = [];
  let capped = false;

  // 1. Cost basis, per selling unit.
  let cost = method === 'manual' ? num(i.manual_cost)
    : method === 'quote' ? num(i.supplier_quote)
    : method === 'latest' ? num(i.latest_cost)
    : (num(i.avg_cost_30d) ?? num(i.latest_cost));
  if (cost == null) cost = num(i.supplier_quote);   // a fresh quote beats nothing

  // 2. Landed cost.
  let landed = null;
  if (cost != null) {
    landed = cost + (kg ?? 0) * ((num(i.transport_per_kg) ?? 0) + (num(i.handling_per_kg) ?? 0)) + (num(i.packing_per_unit) ?? 0);
    landed *= (1 + (num(i.market_fee_pct) ?? 0) / 100) * (1 + (num(i.other_cost_pct) ?? 0) / 100);
    landed /= (num(i.yield_pct) ?? 100) / 100;
    landed /= 1 - (num(i.wastage_pct) ?? 0) / 100;
    landed = round4(landed);
  } else {
    flags.push('no_cost');
  }

  // 3. Raw price by mode.
  let raw = null;
  if (mode === 'manual') {
    raw = num(i.manual_price);
    flags.push('manual');
  } else if (mode === 'fixed_over_benchmark') {
    if (bm == null) flags.push('no_benchmark');
    else raw = bm + (num(i.fixed_margin_amount) ?? 0);
  } else if (landed != null) {
    raw = landed * (1 + (num(i.markup_pct) ?? 0) / 100);
  }

  // 4. Benchmark cap (not for manual prices).
  if (raw != null && mode !== 'manual' && bm != null && cap != null) {
    const ceiling = bm * (1 + cap / 100);
    if (raw > ceiling) { raw = ceiling; capped = true; flags.push('capped'); }
  }

  // 5. Rounding.
  const price = roundPrice(raw, i.rounding_step, i.round_mode);

  // 6. Margin and guard flags.
  let margin = null;
  let markup = null;
  if (price != null && landed != null) {
    margin = round2(price - landed);
    markup = landed > 0 ? round2(((price - landed) / landed) * 100) : null;
    if (price < landed) flags.push('below_cost');
    else if (markup != null && markup < (num(i.min_markup_pct) ?? 0)) flags.push('below_min_markup');
  }
  if (bm != null && (num(i.benchmark_age_days) ?? 0) > 3) flags.push('stale_benchmark');
  const avg = num(i.avg_cost_30d);
  const latest = num(i.latest_cost);
  if (avg != null && latest != null && avg > 0 && Math.abs(latest - avg) / avg > 0.10) flags.push('cost_moved');

  return {
    pricing_mode: mode,
    cost_basis: cost,
    landed_cost: round2(landed),
    raw_price: round4(raw),
    suggested_price: price,
    capped,
    margin_amount: margin,
    margin_pct: price > 0 && margin != null ? round2((margin / price) * 100) : null,
    markup_effective_pct: markup,
    flags,
  };
}

/** Margin of a price over a cost: { amount, pct (of price), markupPct (of cost) }. */
export function marginOf(price, cost) {
  const p = num(price);
  const c = num(cost);
  if (p == null || c == null) return { amount: null, pct: null, markupPct: null };
  const amount = round2(p - c);
  return { amount, pct: p > 0 ? round2((amount / p) * 100) : null, markupPct: c > 0 ? round2((amount / c) * 100) : null };
}

/** Plain-English label and tone for each flag the formula can raise. */
export const FLAG_LABELS = Object.freeze({
  no_cost:          { label: 'No cost on file', tone: 'warn' },
  no_benchmark:     { label: 'No benchmark', tone: 'warn' },
  manual:           { label: 'Manual price', tone: 'info' },
  capped:           { label: 'Held at benchmark cap', tone: 'info' },
  below_cost:       { label: 'Below cost', tone: 'danger' },
  below_min_markup: { label: 'Under minimum markup', tone: 'danger' },
  stale_benchmark:  { label: 'Benchmark older than 3 days', tone: 'warn' },
  cost_moved:       { label: 'Cost moved > 10%', tone: 'warn' },
});

/**
 * Points for a tiny inline chart: an SVG path "d" string that fits `values`
 * (oldest first) into width × height. Empty string when there is nothing to draw.
 */
export function sparklinePath(values, width = 120, height = 32) {
  const v = (values ?? []).map(num).filter((x) => x != null);
  if (v.length < 2) return '';
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const stepX = width / (v.length - 1);
  return v.map((y, n) => `${n === 0 ? 'M' : 'L'}${round2(n * stepX)},${round2(height - ((y - min) / span) * (height - 2) - 1)}`).join(' ');
}
