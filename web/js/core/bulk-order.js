// =============================================================================
// bulk-order.js — CSV bulk order parsing and template generation.
//
// Lets a restaurant upload a CSV with SKU + quantity to add many lines to
// the cart at once. The template is a downloadable starter sheet.
// =============================================================================

/**
 * Parse a CSV text (from a FileReader) into cart-ready line objects.
 * Expected columns (case-insensitive, first two required):
 *   sku, qty, [note]
 *
 * Returns { lines: [{ sku, qty, note }], errors: [{ row, message }] }
 */
export function csvToCartLines(text) {
  const lines = [];
  const errors = [];

  const rows = text.trim().split(/\r?\n/);
  if (rows.length < 2) {
    return { lines: [], errors: [{ row: 0, message: 'File is empty or has no data rows.' }] };
  }

  // Parse header
  const header = rows[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
  const skuIdx = header.indexOf('sku');
  const qtyIdx = header.indexOf('qty');
  const noteIdx = header.indexOf('note');

  if (skuIdx === -1 || qtyIdx === -1) {
    return { lines: [], errors: [{ row: 1, message: 'CSV must have "sku" and "qty" columns in the header row.' }] };
  }

  for (let i = 1; i < rows.length; i++) {
    const rowNum = i + 1;
    const raw = rows[i].trim();
    if (!raw) continue; // skip blank rows

    // Simple CSV parse: split on comma, strip quotes
    const cells = raw.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const sku = (cells[skuIdx] || '').trim().toUpperCase();
    const qtyRaw = (cells[qtyIdx] || '').trim();
    const note = noteIdx >= 0 ? (cells[noteIdx] || '').trim() : '';

    if (!sku) {
      errors.push({ row: rowNum, message: 'Missing SKU.' });
      continue;
    }
    const qty = parseFloat(qtyRaw);
    if (!qtyRaw || isNaN(qty) || qty <= 0) {
      errors.push({ row: rowNum, message: `SKU ${sku}: qty must be a positive number.` });
      continue;
    }

    lines.push({ sku, qty, note });
  }

  return { lines, errors };
}

/**
 * Generate the content of a blank bulk-order CSV template.
 * The caller downloads this file so the user can fill it in.
 *
 * @param {Array<{ sku: string, name: string, unit: string }>} products
 *   Optional: pass the product catalogue to pre-fill the template with all SKUs.
 * @returns {string} CSV text
 */
export function bulkOrderTemplate(products = []) {
  const header = 'sku,qty,note';
  if (products.length === 0) {
    // Plain blank template with a sample row
    return [header, 'TOMATO-1KG,5,', 'ONION-1KG,10,'].join('\r\n') + '\r\n';
  }
  const rows = products.map(p => `${p.sku},,`);
  return [header, ...rows].join('\r\n') + '\r\n';
}
