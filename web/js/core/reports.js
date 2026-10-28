// =============================================================================
// reports.js — pure helpers for the Reports screen and the dashboard chart
// (migration 019). No DOM, no network.
//   reportTotals(rows)          — column totals for the sales report footer
//   reportColumns(groupBy)      — CSV / table columns for a grouping
//   barHeights(values, max=100) — scale a series to percentages for a CSS bar chart
//   isoDate(d) / lastNDays(n)   — India-time date helpers for the filters
// =============================================================================

import { config } from './config.js';

const num = (v) => Number(v) || 0;

/** Sum the money / count columns of sales_report rows. */
export function reportTotals(rows) {
  return rows.reduce((t, r) => ({
    orders: t.orders + num(r.orders), quantity: t.quantity + num(r.quantity), subtotal: t.subtotal + num(r.subtotal),
    tax: t.tax + num(r.tax), delivery_fee: t.delivery_fee + num(r.delivery_fee), total: t.total + num(r.total), cancelled: t.cancelled + num(r.cancelled),
  }), { orders: 0, quantity: 0, subtotal: 0, tax: 0, delivery_fee: 0, total: 0, cancelled: 0 });
}

/** Columns for the table and the CSV. Product / category groupings show quantity and no tax / fee split. */
export function reportColumns(groupBy) {
  const label = { day: 'Day', city: 'City', sector: 'Sector', customer: 'Customer', product: 'Product', category: 'Category' }[groupBy] ?? 'Group';
  const cols = [{ key: 'label', label }, { key: 'orders', label: 'Orders', numeric: true }];
  if (groupBy === 'product' || groupBy === 'category') {
    cols.push({ key: 'quantity', label: 'Quantity', numeric: true });
    cols.push({ key: 'total', label: 'Sales (₹, before GST)', numeric: true, money: true });
  } else {
    cols.push({ key: 'subtotal', label: 'Subtotal (₹)', numeric: true, money: true },
              { key: 'tax', label: 'GST (₹)', numeric: true, money: true },
              { key: 'delivery_fee', label: 'Delivery fees (₹)', numeric: true, money: true },
              { key: 'total', label: 'Total (₹)', numeric: true, money: true });
  }
  cols.push({ key: 'cancelled', label: 'Cancelled', numeric: true });
  return cols;
}

/** Percent heights for a CSS bar chart; an all-zero series gives all zeros. */
export function barHeights(values, max = 100) {
  const peak = Math.max(0, ...values.map(num));
  return values.map((v) => (peak > 0 ? Math.round((num(v) / peak) * max) : 0));
}

/** YYYY-MM-DD for a Date in India time. */
export function isoDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** { from, to } covering the last n days including today. */
export function lastNDays(n) {
  return { from: isoDate(new Date(Date.now() - (n - 1) * 86_400_000)), to: isoDate() };
}

/** Short label for a week-ending date: "26 Oct". */
export function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(d);
}
