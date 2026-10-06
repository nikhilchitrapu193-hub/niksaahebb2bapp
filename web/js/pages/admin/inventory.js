// =============================================================================
// inventory.js — the warehouse: stock on hand, receiving goods from suppliers,
// adjustments and wastage, the movement ledger, and the supplier list.
//
// Stock is never typed straight into a product; every change is a movement
// (see receive_stock / adjust_stock in migration 004) so the ledger always
// explains the number on the shelf.
// =============================================================================

import { html, mount, on, $, $$, formatINR, formatQty, formatDateTime, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listProducts, listSuppliers, saveSupplier, receiveStock, adjustStock, listStockMovements } from '../../core/api.js';

const REASON_LABELS = {
  received: 'Received', order: 'Order', order_cancelled: 'Order cancelled',
  adjustment: 'Adjustment', wastage: 'Wastage', returned: 'Returned',
};

/** Classify stock for the pill: 'empty-stock' | 'low' | 'ok'. */
export function stockLevel(p) {
  const qty = Number(p.stock_qty);
  if (qty <= 0) return 'empty-stock';
  if (qty <= Number(p.low_stock_threshold)) return 'low';
  return 'ok';
}

export async function renderInventory(container) {
  let search = '';
  let onlyLow = false;
  let [products, suppliers] = await Promise.all([listProducts(), listSuppliers()]);

  async function reload() {
    [products, suppliers] = await Promise.all([listProducts(), listSuppliers()]);
    draw();
  }

  function draw() {
    const term = search.trim().toLowerCase();
    const rows = products.filter((p) =>
      (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)) &&
      (!onlyLow || stockLevel(p) !== 'ok'));
    const low = products.filter((p) => stockLevel(p) !== 'ok').length;
    const stockValue = products.reduce((sum, p) => sum + Number(p.stock_qty) * Number(p.price), 0);

    mount(container, html`
      <div class="page-head"><div><h1>Inventory</h1><p>${products.length} products · stock at selling price ${formatINR(stockValue)}</p></div>
        <div class="row-wrap">
          <button class="btn" id="suppliers">Suppliers (${suppliers.length})</button>
          <button class="btn" id="ledger">Ledger</button>
          <button class="btn primary" id="receive">Receive stock</button>
        </div></div>
      ${low ? html`<div class="banner warn">${low} product${low === 1 ? '' : 's'} at or below the low-stock level.
        <button class="btn small" id="toggle-low" style="margin-left:auto">${onlyLow ? 'Show all' : 'Show only these'}</button></div>` : ''}
      <div class="toolbar"><input class="input search" id="search" type="search" placeholder="Search name or SKU…" value="${search}"></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="right">On hand</th><th class="right">Low at</th><th>Level</th><th class="right">Value</th><th></th></tr></thead>
        <tbody>${rows.length === 0 ? html`<tr><td colspan="6"><div class="empty">No products match.</div></td></tr>`
          : rows.map((p) => html`<tr>
            <td><strong>${p.name}</strong><div class="muted small">${p.sku} · ${p.unit}</div></td>
            <td class="right num"><strong>${formatQty(p.stock_qty)}</strong> ${p.unit}</td>
            <td class="right num muted">${formatQty(p.low_stock_threshold)}</td>
            <td><span class="badge ${stockLevel(p)}">${{ 'empty-stock': 'Empty', low: 'Low', ok: 'OK' }[stockLevel(p)]}</span></td>
            <td class="right num">${formatINR(Number(p.stock_qty) * Number(p.price))}</td>
            <td class="right nowrap">
              <button class="btn small" data-history="${p.id}">History</button>
              <button class="btn small" data-adjust="${p.id}">Adjust</button></td></tr>`)}
        </tbody></table></div></div>`);
    const input = $('#search', container);
    input.oninput = () => { search = input.value; draw(); $('#search', container).focus(); };
  }

  on(container, 'click', '#toggle-low', () => { onlyLow = !onlyLow; draw(); });
  on(container, 'click', '#receive', () => receiveForm(products, suppliers, reload));
  on(container, 'click', '#suppliers', () => supplierManager(suppliers, reload));
  on(container, 'click', '#ledger', () => ledgerModal(null, products));
  on(container, 'click', '[data-history]', (_e, el) => ledgerModal(products.find((p) => p.id === el.dataset.history), products));
  on(container, 'click', '[data-adjust]', (_e, el) => adjustForm(products.find((p) => p.id === el.dataset.adjust), reload));

  draw();
}

/** Goods received note: several products from one supplier. */
function receiveForm(products, suppliers, onSaved) {
  const lines = [{ product_id: '', quantity: '', unit_cost: '' }];
  const { el, close } = openModal(html`<form id="grn" class="stack" novalidate></form>`, { title: 'Receive stock (GRN)', wide: true });
  const form = $('#grn', el);

  function draw() {
    mount(form, html`
      <div class="form-grid">
        <label class="field"><span class="label">Supplier</span><select class="select" name="supplier">
          <option value="">— Not specified —</option>
          ${suppliers.filter((s) => s.is_active).map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>
        <label class="field"><span class="label">Reference / note</span><input class="input" name="note" maxlength="300" placeholder="Invoice no., truck, remarks"></label>
      </div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="right">Quantity</th><th class="right">Unit cost (₹)</th><th></th></tr></thead>
        <tbody>${lines.map((line, i) => html`<tr data-line="${i}">
          <td><select class="select small" data-field="product_id" required>
            <option value="">Choose product…</option>
            ${products.map((p) => html`<option value="${p.id}" ${p.id === line.product_id ? 'selected' : ''}>${p.name} (${p.unit})</option>`)}</select></td>
          <td><input class="input small num right" type="number" min="0.01" step="any" data-field="quantity" value="${line.quantity}" required style="width:110px"></td>
          <td><input class="input small num right" type="number" min="0" step="0.01" data-field="unit_cost" value="${line.unit_cost}" style="width:120px"></td>
          <td class="right"><button type="button" class="btn ghost small" data-remove="${i}" ${lines.length === 1 ? 'disabled' : ''}>✕</button></td></tr>`)}
        </tbody></table></div>
      <div><button type="button" class="btn small" id="add-line">+ Add line</button></div>
      <p class="form-error" id="grn-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add to stock</button></div>`);
  }

  on(form, 'change', '[data-field]', (_e, input) => {
    lines[Number(input.closest('[data-line]').dataset.line)][input.dataset.field] = input.value;
  });
  on(form, 'click', '#add-line', () => { lines.push({ product_id: '', quantity: '', unit_cost: '' }); draw(); });
  on(form, 'click', '[data-remove]', (_e, b) => { lines.splice(Number(b.dataset.remove), 1); draw(); });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const payload = lines.filter((l) => l.product_id && Number(l.quantity) > 0)
      .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: l.unit_cost === '' ? null : Number(l.unit_cost) }));
    if (!payload.length) { $('#grn-error', el).textContent = 'Add at least one product with a quantity.'; return; }
    try {
      await withBusy($('button[type="submit"]', form), () => receiveStock(payload, form.elements.supplier.value, form.elements.note.value));
      toast('Stock received', 'success'); close(); onSaved();
    } catch (error) { $('#grn-error', el).textContent = error.message; }
  };
  draw();
}

/** Set an exact count, write off wastage, or accept a return. */
function adjustForm(product, onSaved) {
  const { el, close } = openModal(html`
    <form id="adj" class="stack" novalidate>
      <p>Current stock: <strong class="num">${formatQty(product.stock_qty)} ${product.unit}</strong></p>
      <div class="form-grid">
        <label class="field"><span class="label">New quantity (${product.unit})</span><input class="input num" type="number" min="0" step="any" name="qty" value="${formatQty(product.stock_qty)}" required></label>
        <label class="field"><span class="label">Reason</span><select class="select" name="reason">
          <option value="adjustment">Stock count correction</option>
          <option value="wastage">Wastage / damaged / expired</option>
          <option value="returned">Customer return</option></select></label>
      </div>
      <label class="field"><span class="label">Note</span><input class="input" name="note" maxlength="300" placeholder="e.g. 5 kg spoiled in cold room"></label>
      <p class="form-error" id="adj-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, { title: `Adjust: ${product.name}` });
  $('#adj', el).onsubmit = async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await withBusy($('button[type="submit"]', form), () => adjustStock(product.id, Number(form.elements.qty.value), form.elements.reason.value, form.elements.note.value));
      toast('Stock updated', 'success'); close(); onSaved();
    } catch (error) { $('#adj-error', el).textContent = error.message; }
  };
}

/** Movement history, for one product or the whole warehouse. */
async function ledgerModal(product, products) {
  const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span></div>`,
    { title: product ? `History: ${product.name}` : 'Stock ledger (latest 100)', wide: true });
  try {
    const rows = await listStockMovements(product?.id, product ? 50 : 100);
    const nameOf = Object.fromEntries(products.map((p) => [p.id, p]));
    mount(el, rows.length === 0 ? html`<div class="empty">No movements yet.</div>` : html`
      <div class="table-wrap"><table class="table">
        <thead><tr><th>When</th>${product ? '' : html`<th>Product</th>`}<th>Reason</th><th class="right">Change</th><th>Reference</th><th class="right">Unit cost</th></tr></thead>
        <tbody>${rows.map((m) => html`<tr>
          <td class="nowrap muted">${formatDateTime(m.created_at)}</td>
          ${product ? '' : html`<td>${nameOf[m.product_id]?.name ?? '—'}</td>`}
          <td>${REASON_LABELS[m.reason] ?? m.reason}</td>
          <td class="right num" style="color:${m.qty_delta > 0 ? 'var(--ok)' : 'var(--danger)'}">${m.qty_delta > 0 ? '+' : ''}${formatQty(m.qty_delta)}</td>
          <td class="small">${m.orders?.order_number ?? m.suppliers?.name ?? ''}${m.note ? html` <span class="muted">${m.note}</span>` : ''}</td>
          <td class="right num muted">${m.unit_cost != null ? formatINR(m.unit_cost) : ''}</td></tr>`)}</tbody></table></div>`);
  } catch (error) { close(); reportError(error); }
}

function supplierManager(suppliers, onChanged) {
  const { el } = openModal(html`<div id="sup"></div>`, { title: 'Suppliers', wide: true });
  const host = $('#sup', el);
  let list = suppliers;

  function draw() {
    mount(host, html`
      ${list.map((s) => html`<div class="line" data-id="${s.id}">
        <input class="input small" value="${s.name}" data-name aria-label="Name" style="flex:2">
        <input class="input small" value="${s.contact ?? ''}" data-contact placeholder="Contact person" aria-label="Contact">
        <input class="input small" value="${s.phone ?? ''}" data-phone placeholder="Phone" aria-label="Phone" style="width:140px">
        <label class="check small"><input type="checkbox" data-active ${s.is_active ? 'checked' : ''}> Active</label>
        <button class="btn small" data-save>Save</button></div>`)}
      <form id="add-sup" class="row-wrap" style="margin-top:var(--space-4)">
        <input class="input" name="name" placeholder="New supplier name" required maxlength="120" style="flex:2">
        <input class="input" name="phone" placeholder="Phone" maxlength="20">
        <button class="btn primary" type="submit">Add</button></form>`);
  }
  async function refresh() { list = await listSuppliers(); draw(); onChanged(); }

  on(host, 'click', '[data-save]', async (_e, b) => {
    const row = b.closest('[data-id]');
    try {
      await saveSupplier({ id: row.dataset.id, name: $('[data-name]', row).value, contact: $('[data-contact]', row).value,
        phone: $('[data-phone]', row).value, is_active: $('[data-active]', row).checked });
      toast('Saved', 'success'); await refresh();
    } catch (error) { reportError(error); }
  });
  on(host, 'submit', '#add-sup', async (event, form) => {
    event.preventDefault();
    try { await saveSupplier({ name: form.elements.name.value, phone: form.elements.phone.value }); await refresh(); } catch (error) { reportError(error); }
  });
  draw();
}
