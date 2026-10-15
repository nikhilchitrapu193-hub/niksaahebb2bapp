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

/**
 * Parse CSV text into objects keyed by the header row (benchmark uploads).
 * Handles quoted cells, doubled quotes, CRLF and a leading BOM. Pure.
 * Returns { headers: ['sku', ...], rows: [{ sku: '...', ... }] }.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^﻿/, '');
  for (let n = 0; n < src.length; n += 1) {
    const ch = src[n];
    if (quoted) {
      if (ch === '"' && src[n + 1] === '"') { field += '"'; n += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[n + 1] === '\n') n += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return {
    headers,
    rows: nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))),
  };
}

/** Read a chosen <input type="file"> file as text (works in every browser; File.text() does not). */
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}
