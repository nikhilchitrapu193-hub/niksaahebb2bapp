// =============================================================================
// csv.js — "Export to CSV" for any list. toCsv() is pure (unit-tested);
// downloadCsv() hands the file to the browser. Opens directly in Excel.
//
// columns: [{ key: 'order_number', label: 'Order' }, { key: 'total', label: 'Total', value: (row) => ... }]
// A column's `value` function wins over `key` when present.
// =============================================================================

/** Quote a cell the way Excel expects: wrap in quotes, double inner quotes. */
function cell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Build CSV text (with a header row) from rows and column definitions. */
export function toCsv(rows, columns) {
  const header = columns.map((c) => cell(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => cell(c.value ? c.value(row) : row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

/** Trigger a download of `rows` as `filename` (add .csv yourself). */
export function downloadCsv(filename, rows, columns) {
  // The BOM makes Excel read ₹ and other non-ASCII characters correctly.
  const blob = new Blob(['﻿' + toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
