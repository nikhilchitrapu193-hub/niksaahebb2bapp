// =============================================================================
// launch.js — the "lite mode" rules, as pure functions (no DOM, no network).
//
// Settings → Launch (migration 014) gives the admin three switches: which
// SECTORS are live (sectors.is_active), the PRICING mode and the STOCK mode
// (company_settings.pricing_mode / stock_mode). The database enforces the
// parts that matter (a sector that is off cannot order; simple stock never
// reserves). These helpers decide what the admin app SHOWS for the two modes,
// so every screen reads the same rule. Tested in tests/unit.test.js.
// =============================================================================

/** True when prices are typed on the product form (no pricing engine screens). */
export function isSimplePricing(settings) {
  return settings?.pricing_mode === 'simple';
}

/** True when stock is only an in-stock / out-of-stock flag (no ledger screens). */
export function isSimpleStock(settings) {
  return settings?.stock_mode === 'simple';
}

/**
 * Admin modules hidden by the current modes. The permission matrix still
 * applies on top (a hidden module is not granted by being unhidden).
 *   simple pricing → pricing (board, rules, benchmarks, price lists)
 *   simple stock   → inventory, procurement (receipts, POs, rate cards, buying list)
 */
export function hiddenModules(settings) {
  const hidden = new Set();
  if (isSimplePricing(settings)) hidden.add('pricing');
  if (isSimpleStock(settings)) { hidden.add('inventory'); hidden.add('procurement'); }
  return hidden;
}

/** True when the app is running in the lightest setting (both switches simple). */
export function isLite(settings) {
  return isSimplePricing(settings) && isSimpleStock(settings);
}

/**
 * One line per thing that is switched off, for the dashboard banner. Empty
 * when everything is on (the full app). `sectors` = rows from the sectors table.
 */
export function launchSummary(settings, sectors = []) {
  const lines = [];
  const off = sectors.filter((s) => !s.is_active).map((s) => s.name);
  const on = sectors.filter((s) => s.is_active).map((s) => s.name);
  if (off.length) lines.push(`Live for ${on.length ? on.join(', ') : 'no sector yet'} · not yet: ${off.join(', ')}`);
  if (isSimplePricing(settings)) lines.push('Simple pricing: prices are typed on the product form');
  if (isSimpleStock(settings)) lines.push('Simple stock: in stock / out of stock only, no quantities');
  return lines;
}
