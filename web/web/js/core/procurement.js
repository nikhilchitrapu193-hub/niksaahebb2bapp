// =============================================================================
// procurement.js — pure helpers for the buying list, purchase orders and
// receipts. No DOM, no network; unit-tested. The buying-list arithmetic
// mirrors buying_list() in migration 011 — change both or neither.
// =============================================================================

/**
 * How much to buy: enough to cover the day's demand again (`coverDays` times)
 * plus the low-stock alert level, minus what is free in stock and already on
 * order. Never negative. Mirror of the SQL expression in buying_list().
 */
export function suggestedBuy({ demand_qty, free_stock, open_po_qty, low_stock_threshold }, coverDays = 1) {
  const n = (v) => Number(v) || 0;
  return Math.max(0, Math.round((n(demand_qty) * Number(coverDays || 1) + n(low_stock_threshold) - n(free_stock) - n(open_po_qty)) * 100) / 100);
}

/** Round a buy quantity up to the supplier's MOQ (a multiple of it when > 1). */
export function roundToMoq(qty, moq) {
  const m = Number(moq) || 1;
  if (qty <= 0) return 0;
  return Math.ceil(qty / m) * m;
}

/**
 * Group chosen buying-list rows by supplier for "create purchase orders":
 * [{ supplier_id, supplier_name, lines: [{ product_id, name, unit, quantity, unit_cost }] }].
 * Rows with no supplier land under supplier_id null (the screen asks for one).
 */
export function groupBySupplier(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.supplier_id ?? null;
    if (!groups.has(key)) groups.set(key, { supplier_id: key, supplier_name: r.supplier_name ?? null, lines: [] });
    groups.get(key).lines.push({ product_id: r.product_id, name: r.name, unit: r.unit, quantity: Number(r.quantity), unit_cost: r.rate == null ? null : Number(r.rate) });
  }
  return [...groups.values()];
}

/** PO totals from its lines: { ordered, received, rejected, value } (value = Σ qty_ordered × unit_cost where a cost exists). */
export function poTotals(items = []) {
  return items.reduce((t, i) => ({
    ordered: t.ordered + Number(i.qty_ordered),
    received: t.received + Number(i.qty_received ?? 0),
    rejected: t.rejected + Number(i.qty_rejected ?? 0),
    value: t.value + (i.unit_cost == null ? 0 : Number(i.qty_ordered) * Number(i.unit_cost)),
  }), { ordered: 0, received: 0, rejected: 0, value: 0 });
}

/** What is still open on each PO line: [{ ...item, outstanding }] with outstanding = ordered − received − rejected, floored at 0. */
export function outstandingLines(items = []) {
  return items.map((i) => ({ ...i, outstanding: Math.max(0, Number(i.qty_ordered) - Number(i.qty_received ?? 0) - Number(i.qty_rejected ?? 0)) }));
}

/** Plain-text purchase order for WhatsApp / SMS. */
export function poMessage(po, company) {
  const lines = (po.purchase_order_items ?? []).map((i) =>
    `• ${i.products?.name ?? i.product_id}: ${Number(i.qty_ordered)} ${i.products?.unit ?? ''}${i.unit_cost != null ? ` @ ₹${Number(i.unit_cost).toFixed(2)}` : ''}`);
  return [
    `Purchase order ${po.po_number} from ${company?.name ?? 'Fresh Supply'}`,
    po.expected_date ? `Deliver by ${po.expected_date} to ${po.warehouses?.name ?? 'our warehouse'}${po.warehouses?.address ? `, ${po.warehouses.address}` : ''}` : `Deliver to ${po.warehouses?.name ?? 'our warehouse'}`,
    '',
    ...lines,
    po.notes ? `\nNote: ${po.notes}` : '',
    `\nPlease confirm. ${company?.phone ? `Call ${company.phone}.` : ''}`.trimEnd(),
  ].filter((l) => l !== '').join('\n');
}

/** wa.me link with the message pre-filled (phone digits only; no phone = pick a contact). */
export function whatsappLink(phone, text) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const to = digits ? (digits.length === 10 ? `91${digits}` : digits) : '';
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
