// =============================================================================
// fulfilment.js — pure helpers for the pick list, trip sheets, delivery and
// driver cash. No DOM, no network; unit-tested. Figures here are for display
// and in-browser recalculation only; the database is the source of truth.
// =============================================================================

/** A trip's stops (its orders) in delivery order. */
export function tripStops(trip) {
  return [...(trip?.trip_orders ?? [])]
    .sort((a, b) => (a.stop_seq ?? 0) - (b.stop_seq ?? 0))
    .map((t) => t.orders)
    .filter(Boolean);
}

/** Cash the driver should collect on a trip = unpaid COD orders' totals. */
export function tripCodToCollect(trip) {
  return tripStops(trip)
    .filter((o) => o.payment_method === 'cod' && o.payment_status !== 'paid')
    .reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
}

/** How many of a trip's stops are still to deliver (not delivered / cancelled). */
export function tripOpenStops(trip) {
  return tripStops(trip).filter((o) => o.status !== 'delivered' && o.status !== 'cancelled').length;
}

/** Severity of a batch's remaining shelf life, for colour-coding. */
export function expiryTone(daysLeft) {
  if (daysLeft == null || daysLeft === '') return 'ok';
  const d = Number(daysLeft);
  if (Number.isNaN(d)) return 'ok';
  if (d < 0) return 'expired';
  if (d <= 2) return 'soon';
  return 'ok';
}

/** Totals across pick-list rows: distinct products, total units and how many fall short. */
export function pickListTotals(rows = []) {
  return rows.reduce((t, r) => ({
    products: t.products + 1,
    units: t.units + Number(r.pick_qty || 0),
    shortProducts: t.shortProducts + (Number(r.short || 0) > 0 ? 1 : 0),
  }), { products: 0, units: 0, shortProducts: 0 });
}

/** Cash a driver still holds (collected − settled); mirrors driver_cash_summary. */
export function cashInHand(row) {
  return Number(row?.collected || 0) - Number(row?.settled || 0);
}

/**
 * Validate doorstep-return lines against the order's items before sending them.
 * items: order_items; picks: Map(order_item_id → qty). Returns { lines, error }.
 * A line must return more than zero and strictly less than the billed quantity
 * (a whole-line refusal is a cancellation, not a return).
 */
export function buildReturns(items, picks) {
  const lines = [];
  for (const [itemId, qty] of picks.entries()) {
    const n = Number(qty);
    if (!n) continue;
    const item = items.find((i) => i.id === itemId);
    if (!item) return { error: 'Unknown line in the return.' };
    if (n < 0) return { error: 'A return quantity cannot be negative.' };
    if (n >= Number(item.quantity)) return { error: `Return less than the full "${item.product_name}" — refuse the whole order instead.` };
    lines.push({ order_item_id: itemId, qty: n });
  }
  return { lines };
}
