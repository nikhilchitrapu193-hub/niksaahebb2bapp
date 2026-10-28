// =============================================================================
// receivables.js — pure helpers for Payments & credit (migration 015): the
// oldest-due-first allocation preview, ageing totals and the statement CSV.
// The database does the real allocation (allocate_customer_credits /
// allocate_payment); fifoAllocate() only shows the staff member what a receipt
// WILL cover before they save it, with the same rule. Tested in tests/unit.test.js.
// =============================================================================

/**
 * Spread `amount` over open items oldest-due-first (then by date). items =
 * [{ id, balance, due_date, item_date }]. Returns [{ id, amount }] and the
 * leftover that would stay on account.
 */
export function fifoAllocate(amount, items) {
  let left = Number(amount) || 0;
  const sorted = [...items]
    .filter((i) => Number(i.balance) > 0)
    .sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999'))
                 || String(a.item_date ?? '').localeCompare(String(b.item_date ?? '')));
  const lines = [];
  for (const item of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, Number(item.balance));
    lines.push({ id: item.id, kind: item.kind, number: item.number, amount: round2(take) });
    left = round2(left - take);
  }
  return { lines, leftover: left };
}

/** Sum the ageing buckets of receivables_summary rows. */
export function agingTotals(rows) {
  const keys = ['outstanding', 'current_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'overdue', 'unapplied_credit'];
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) for (const k of keys) totals[k] = round2(totals[k] + (Number(r[k]) || 0));
  return totals;
}

/** Whole days an item is past due on `today` (YYYY-MM-DD strings); 0 when not due. */
export function daysOverdue(dueDate, today) {
  if (!dueDate || !today) return 0;
  const days = Math.floor((Date.parse(today) - Date.parse(dueDate)) / 86_400_000);
  return days > 0 ? days : 0;
}

/** Which ageing bucket a number of overdue days falls in (labels match the report columns). */
export function agingBucket(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return '1–30';
  if (days <= 60) return '31–60';
  if (days <= 90) return '61–90';
  return '90+';
}

function round2(n) { return Math.round(n * 100) / 100; }
