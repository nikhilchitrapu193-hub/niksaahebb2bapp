// =============================================================================
// grn.js — goods receipts (Procurement → Receipts) and the ONE form used to
// receive goods anywhere in the admin app: against a purchase order (from the
// PO screen), a mandi cash purchase with a bill photo, or a direct delivery
// (the Inventory screen's "Receive stock"). Every line has accepted and
// rejected quantities, a grade and an optional photo; accepted stock enters
// the ledger through receive_goods(), rejected stock never does.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, formatDateTime, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listGoodsReceipts, listWarehouses, listSuppliers, listProducts, receiveGoods, uploadBillPhoto, billPhotoUrl } from '../../core/api.js';
import { GRN_SOURCES } from '../../core/config.js';
import { outstandingLines } from '../../core/procurement.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';
import { procurementTabs } from './buying-list.js';

export async function renderReceipts(container, me) {
  const canReceive = can(me, 'inventory', 'edit');
  const canExport = can(me, 'procurement', 'export') || can(me, 'inventory', 'export');
  let warehouseId = '';
  let [receipts, warehouses, suppliers, products] = await Promise.all([listGoodsReceipts(), listWarehouses(), listSuppliers(), listProducts()]);

  async function reload() { receipts = await listGoodsReceipts({ warehouseId: warehouseId || undefined }); draw(); }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Goods receipts</h1><p>${receipts.length} receipts · every delivery, mandi purchase and direct receipt, with its quality check.</p></div>
        <div class="row">
          ${canExport ? html`<button class="btn" id="export">Export CSV</button>` : ''}
          ${canReceive ? html`<button class="btn" id="mandi">Mandi cash purchase</button><button class="btn primary" id="receive">Receive goods</button>` : ''}
        </div></div>
      ${procurementTabs('#receipts')}
      <div class="toolbar"><select class="select" id="warehouse"><option value="">All warehouses</option>
        ${warehouses.map((w) => html`<option value="${w.id}" ${w.id === warehouseId ? 'selected' : ''}>${w.name}</option>`)}</select></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>GRN</th><th>When</th><th>Source</th><th>Supplier / PO</th><th>Warehouse</th><th class="right">Accepted</th><th class="right">Rejected</th><th class="right">Bill</th><th></th></tr></thead>
        <tbody>${receipts.length === 0 ? html`<tr><td colspan="9"><div class="empty">No receipts yet.</div></td></tr>` : receipts.map((g) => {
          const acc = g.goods_receipt_items.reduce((n, i) => n + Number(i.qty_accepted), 0);
          const rej = g.goods_receipt_items.reduce((n, i) => n + Number(i.qty_rejected), 0);
          return html`<tr data-id="${g.id}">
            <td><strong>${g.grn_number}</strong></td><td class="muted small">${formatDateTime(g.created_at)}</td>
            <td>${GRN_SOURCES[g.source]?.label ?? g.source}${g.paid_cash ? html` <span class="badge approved">cash</span>` : ''}</td>
            <td>${g.suppliers?.name ?? '—'}${g.purchase_orders?.po_number ? html` · ${g.purchase_orders.po_number}` : ''}</td>
            <td>${g.warehouses?.name ?? ''}</td>
            <td class="right num">${formatQty(acc)}</td><td class="right num ${rej > 0 ? 'money' : ''}">${formatQty(rej)}</td>
            <td class="right num">${g.bill_amount != null ? formatINR(g.bill_amount) : '—'}</td>
            <td class="right"><button class="btn small" data-open="${g.id}">View</button></td></tr>`; })}</tbody></table></div></div>`);
  }

  on(container, 'change', '#warehouse', async (_e, el) => { warehouseId = el.value; try { await reload(); } catch (error) { reportError(error); } });
  on(container, 'click', '#receive', () => receiveForm({ products, suppliers, warehouses, source: 'direct' }, reload));
  on(container, 'click', '#mandi', () => receiveForm({ products, suppliers, warehouses, source: 'mandi' }, reload));
  on(container, 'click', '[data-open]', (_e, el) => receiptDetail(receipts.find((g) => g.id === el.dataset.open)));
  on(container, 'click', '#export', () => downloadCsv('goods-receipts.csv',
    receipts.flatMap((g) => g.goods_receipt_items.map((i) => ({ ...i, grn: g }))), [
      { label: 'GRN', value: (r) => r.grn.grn_number }, { label: 'Date', value: (r) => r.grn.created_at }, { label: 'Source', value: (r) => r.grn.source },
      { label: 'Supplier', value: (r) => r.grn.suppliers?.name ?? '' }, { label: 'PO', value: (r) => r.grn.purchase_orders?.po_number ?? '' },
      { label: 'Warehouse', value: (r) => r.grn.warehouses?.name ?? '' }, { label: 'SKU', value: (r) => r.products?.sku }, { label: 'Product', value: (r) => r.products?.name },
      { key: 'qty_accepted', label: 'Accepted' }, { key: 'qty_rejected', label: 'Rejected' }, { key: 'reject_reason', label: 'Reject reason' },
      { key: 'grade', label: 'Grade' }, { key: 'unit_cost', label: 'Unit cost' }, { label: 'Bill amount', value: (r) => r.grn.bill_amount ?? '' },
    ]));

  draw();
}

async function receiptDetail(g) {
  const billUrl = await billPhotoUrl(g.bill_photo_path).catch(() => null);
  openModal(html`
    <div class="stack">
      <dl class="kv compact">
        <dt>When</dt><dd>${formatDateTime(g.created_at)}</dd>
        <dt>Source</dt><dd>${GRN_SOURCES[g.source]?.label ?? g.source}${g.paid_cash ? ' · paid in cash' : ''}</dd>
        ${g.suppliers?.name ? html`<dt>Supplier</dt><dd>${g.suppliers.name}</dd>` : ''}
        ${g.purchase_orders?.po_number ? html`<dt>Purchase order</dt><dd>${g.purchase_orders.po_number}</dd>` : ''}
        <dt>Warehouse</dt><dd>${g.warehouses?.name ?? ''}</dd>
        ${g.bill_amount != null ? html`<dt>Bill</dt><dd>${formatINR(g.bill_amount)}${billUrl ? html` · <a href="${billUrl}" target="_blank" rel="noopener">photo</a>` : ''}</dd>` : ''}
        ${g.note ? html`<dt>Note</dt><dd>${g.note}</dd>` : ''}
      </dl>
      <div class="table-wrap"><table class="table small-table">
        <thead><tr><th>Product</th><th class="right">Accepted</th><th class="right">Rejected</th><th>Reason</th><th>Grade</th><th class="right">Unit cost</th></tr></thead>
        <tbody>${g.goods_receipt_items.map((i) => html`<tr><td>${i.products?.name ?? ''}</td>
          <td class="right num">${formatQty(i.qty_accepted)} ${i.products?.unit ?? ''}</td>
          <td class="right num">${Number(i.qty_rejected) > 0 ? formatQty(i.qty_rejected) : '—'}</td>
          <td>${i.reject_reason ?? ''}</td><td>${i.grade ?? ''}</td>
          <td class="right num">${i.unit_cost != null ? formatINR(i.unit_cost) : '—'}</td></tr>`)}</tbody></table></div>
    </div>`, { title: g.grn_number, wide: true });
}

/**
 * The receive-goods form. options: { products, suppliers, warehouses, source, po?, warehouseId? }.
 * With a PO the lines are the PO's outstanding lines; otherwise the user adds lines.
 */
export function receiveForm({ products, suppliers, warehouses, source = 'direct', po = null, warehouseId = '' }, onSaved) {
  const lines = po
    ? outstandingLines(po.purchase_order_items).filter((i) => i.outstanding > 0)
        .map((i) => ({ product_id: i.product_id, name: i.products?.name, unit: i.products?.unit, qty_accepted: i.outstanding, qty_rejected: '', unit_cost: i.unit_cost ?? '', grade: '', reject_reason: '' }))
    : [{ product_id: '', qty_accepted: '', qty_rejected: '', unit_cost: '', grade: '', reject_reason: '' }];
  let billPath = null;
  const title = po ? `Receive ${po.po_number}` : source === 'mandi' ? 'Mandi cash purchase' : 'Receive goods (GRN)';
  const { el, close } = openModal(html`<form id="grn" class="stack" novalidate></form>`, { title, wide: true });
  const form = $('#grn', el);

  function draw() {
    mount(form, html`
      <div class="form-grid">
        <label class="field"><span class="label">Into warehouse</span><select class="select" name="warehouse" required ${po ? 'disabled' : ''}>
          ${warehouses.map((w) => html`<option value="${w.id}" ${w.id === (po?.warehouse_id ?? warehouseId) || (!po && !warehouseId && w.is_default) ? 'selected' : ''}>${w.name}</option>`)}</select></label>
        ${po ? html`<div class="field"><span class="label">Supplier</span><div style="padding:0.6rem 0">${po.suppliers?.name ?? ''}</div></div>`
             : source === 'mandi' ? html`<label class="field"><span class="label">Mandi / vendor (optional)</span><select class="select" name="supplier"><option value="">— Not a listed supplier —</option>
                 ${suppliers.filter((s) => s.is_active).map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>`
             : html`<label class="field"><span class="label">Supplier</span><select class="select" name="supplier"><option value="">— Not specified —</option>
                 ${suppliers.filter((s) => s.is_active).map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>`}
        ${source === 'mandi' ? html`
          <label class="field"><span class="label">Bill amount (₹)</span><input class="input" name="bill_amount" type="number" min="0" step="0.01" required></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="paid_cash" checked> Paid in cash</label>
          <div class="field span-2"><span class="label">Photo of the bill</span><div class="row"><div id="bill-preview" class="muted small">None yet</div><input type="file" id="bill-photo" accept="image/jpeg,image/png,image/webp" capture="environment"></div></div>` : ''}
        <label class="field span-2"><span class="label">Reference / note</span><input class="input" name="note" maxlength="300" placeholder="Invoice no., truck, remarks"></label>
      </div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="right">Accepted</th><th class="right">Rejected</th><th>Reject reason</th><th>Grade</th><th class="right">Unit cost (₹)</th><th></th></tr></thead>
        <tbody>${lines.map((line, i) => html`<tr data-line="${i}">
          <td>${po ? html`<strong>${line.name}</strong><div class="muted tiny">${line.unit}</div>` : html`<select class="select small" data-field="product_id" required style="min-width:170px;max-width:220px">
            <option value="">Choose product…</option>
            ${products.filter((p) => p.is_active).map((p) => html`<option value="${p.id}" ${p.id === line.product_id ? 'selected' : ''}>${p.name} (${p.unit})</option>`)}</select>`}</td>
          <td><input class="input small num right" type="number" min="0" step="any" data-field="qty_accepted" value="${line.qty_accepted}" style="width:88px" aria-label="Accepted"></td>
          <td><input class="input small num right" type="number" min="0" step="any" data-field="qty_rejected" value="${line.qty_rejected}" style="width:88px" aria-label="Rejected"></td>
          <td><input class="input small" data-field="reject_reason" value="${line.reject_reason}" maxlength="120" placeholder="bruised, short…" style="width:130px" aria-label="Reject reason"></td>
          <td><input class="input small" data-field="grade" value="${line.grade}" maxlength="20" placeholder="A" style="width:56px" aria-label="Grade"></td>
          <td><input class="input small num right" type="number" min="0" step="0.01" data-field="unit_cost" value="${line.unit_cost}" style="width:96px" aria-label="Unit cost"></td>
          <td class="right">${po ? '' : html`<button type="button" class="btn ghost small" data-remove="${i}" ${lines.length === 1 ? 'disabled' : ''}>✕</button>`}</td></tr>`)}
        </tbody></table></div>
      ${po ? '' : html`<div><button type="button" class="btn small" id="add-line">+ Add line</button></div>`}
      <p class="muted small">Rejected quantity stays out of stock and is recorded with its reason (returned to the supplier).</p>
      <p class="form-error" id="grn-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${po ? 'Receive' : 'Add to stock'}</button></div>`);
    const photo = $('#bill-photo', el);
    if (photo) photo.onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try { billPath = await uploadBillPhoto(file); $('#bill-preview', el).textContent = `Uploaded: ${file.name}`; }
      catch (error) { reportError(error); event.target.value = ''; }
    };
  }

  on(form, 'change', '[data-field]', (_e, input) => {
    lines[Number(input.closest('[data-line]').dataset.line)][input.dataset.field] = input.value;
  });
  on(form, 'click', '#add-line', () => { lines.push({ product_id: '', qty_accepted: '', qty_rejected: '', unit_cost: '', grade: '', reject_reason: '' }); draw(); });
  on(form, 'click', '[data-remove]', (_e, b) => { lines.splice(Number(b.dataset.remove), 1); draw(); });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const items = lines.filter((l) => l.product_id && (Number(l.qty_accepted) > 0 || Number(l.qty_rejected) > 0))
      .map((l) => ({ product_id: l.product_id, qty_accepted: Number(l.qty_accepted) || 0, qty_rejected: Number(l.qty_rejected) || 0,
                     unit_cost: l.unit_cost === '' ? null : Number(l.unit_cost), grade: l.grade || null, reject_reason: l.reject_reason || null }));
    if (!items.length) { $('#grn-error', el).textContent = 'Enter an accepted or rejected quantity on at least one line.'; return; }
    if (items.some((i) => i.qty_rejected > 0 && !i.reject_reason)) { $('#grn-error', el).textContent = 'Give a reason for every rejected quantity.'; return; }
    try {
      const result = await withBusy($('button[type="submit"]', form), () => receiveGoods({
        warehouseId: po ? po.warehouse_id : form.elements.warehouse.value,
        supplierId: po ? null : form.elements.supplier?.value || null,
        poId: po?.id ?? null, source: po ? 'po' : source, items, note: form.elements.note.value,
        billPhotoPath: billPath, billAmount: form.elements.bill_amount?.value, paidCash: form.elements.paid_cash?.checked ?? false,
      }));
      toast(`${result.grn_number} recorded${result.po_status ? ` · PO ${result.po_status.replace('_', ' ')}` : ''}`, 'success');
      close(); onSaved?.(result);
    } catch (error) { $('#grn-error', el).textContent = error.message; }
  };
  draw();
}
