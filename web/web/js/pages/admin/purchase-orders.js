// =============================================================================
// purchase-orders.js — Procurement → Purchase orders: list, detail, create /
// edit a draft, approve & send (procurement:approve), share on WhatsApp or
// print (po.html), receive against it (opens the GRN form), close short or
// cancel. Status flow: draft → sent → part received → closed; or cancelled.
// =============================================================================

import { html, mount, on, $, formatINR, formatQty, formatDate, formatDateTime, openModal, confirmDialog, reportError, toast, withBusy } from '../../core/ui.js';
import { listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder, setPurchaseOrderStatus,
         listSuppliers, listWarehouses, listProducts, listSupplierProducts, getCompanySettings } from '../../core/api.js';
import { PO_STATUSES, webRoot } from '../../core/config.js';
import { poTotals, outstandingLines, poMessage, whatsappLink } from '../../core/procurement.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';
import { procurementTabs } from './buying-list.js';
import { receiveForm } from './grn.js';

export async function renderPurchaseOrders(container, me) {
  const canEdit = can(me, 'procurement', 'edit');
  const canApprove = can(me, 'procurement', 'approve');
  const canReceive = can(me, 'inventory', 'edit');
  const canExport = can(me, 'procurement', 'export');
  let status = '';
  let [orders, suppliers, warehouses, products] = await Promise.all([listPurchaseOrders(), listSuppliers(), listWarehouses(), listProducts()]);

  async function reload() { orders = await listPurchaseOrders({ status: status || undefined }); draw(); }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Purchase orders</h1><p>${orders.length} shown · ${orders.filter((o) => o.status === 'draft').length} drafts waiting for approval</p></div>
        <div class="row">
          ${canExport ? html`<button class="btn" id="export">Export CSV</button>` : ''}
          ${canEdit ? html`<button class="btn primary" id="new">New purchase order</button>` : ''}
        </div></div>
      ${procurementTabs('#purchase-orders')}
      <div class="toolbar"><select class="select" id="status"><option value="">All statuses</option>
        ${Object.entries(PO_STATUSES).map(([k, v]) => html`<option value="${k}" ${k === status ? 'selected' : ''}>${v.label}</option>`)}</select></div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>PO</th><th>Supplier</th><th>Warehouse</th><th>Deliver by</th><th class="right">Lines</th><th class="right">Value</th><th class="right">Received</th><th>Status</th><th></th></tr></thead>
        <tbody>${orders.length === 0 ? html`<tr><td colspan="9"><div class="empty">No purchase orders. Start from the buying list.</div></td></tr>` : orders.map((o) => {
          const t = poTotals(o.purchase_order_items);
          return html`<tr class="clickable" data-open="${o.id}">
            <td><strong>${o.po_number}</strong><div class="muted tiny">${formatDateTime(o.created_at)}</div></td>
            <td>${o.suppliers?.name ?? '—'}</td><td>${o.warehouses?.name ?? ''}</td><td>${formatDate(o.expected_date)}</td>
            <td class="right num">${o.purchase_order_items.length}</td>
            <td class="right num">${t.value > 0 ? formatINR(t.value) : '—'}</td>
            <td class="right num">${formatQty(t.received)} / ${formatQty(t.ordered)}${t.rejected > 0 ? html`<div class="muted tiny">${formatQty(t.rejected)} rejected</div>` : ''}</td>
            <td><span class="badge ${PO_STATUSES[o.status]?.badge ?? ''}">${PO_STATUSES[o.status]?.label ?? o.status}</span></td>
            <td class="right"><button class="btn small">Open</button></td></tr>`; })}</tbody></table></div></div>`);
  }

  on(container, 'change', '#status', async (_e, el) => { status = el.value; try { await reload(); } catch (error) { reportError(error); } });
  on(container, 'click', '#new', () => poForm(null, { suppliers, warehouses, products, me }, reload));
  on(container, 'click', '[data-open]', (_e, el) => detail(el.dataset.open));
  on(container, 'click', '#export', () => downloadCsv('purchase-orders.csv',
    orders.flatMap((o) => o.purchase_order_items.map((i) => ({ ...i, po: o }))), [
      { label: 'PO', value: (r) => r.po.po_number }, { label: 'Status', value: (r) => r.po.status }, { label: 'Supplier', value: (r) => r.po.suppliers?.name ?? '' },
      { label: 'Warehouse', value: (r) => r.po.warehouses?.name ?? '' }, { label: 'Deliver by', value: (r) => r.po.expected_date ?? '' },
      { label: 'SKU', value: (r) => r.products?.sku }, { label: 'Product', value: (r) => r.products?.name }, { key: 'qty_ordered', label: 'Ordered' },
      { key: 'unit_cost', label: 'Unit cost' }, { key: 'qty_received', label: 'Received' }, { key: 'qty_rejected', label: 'Rejected' },
    ]));

  async function detail(id) {
    const { el, close } = openModal(html`<div class="loading"><span class="spinner"></span> Loading…</div>`, { title: 'Purchase order', wide: true });
    try {
      const [po, company] = await Promise.all([getPurchaseOrder(id), getCompanySettings().catch(() => null)]);
      if (!po) throw new Error('Purchase order not found');
      const t = poTotals(po.purchase_order_items);
      const lines = outstandingLines(po.purchase_order_items);
      const open = po.status === 'sent' || po.status === 'part_received';
      mount(el, html`
        <div class="spread"><div><strong>${po.po_number}</strong> <span class="badge ${PO_STATUSES[po.status]?.badge ?? ''}">${PO_STATUSES[po.status]?.label ?? po.status}</span></div>
          <span class="muted small">${formatDateTime(po.created_at)}</span></div>
        <dl class="kv compact" style="margin:var(--space-3) 0">
          <dt>Supplier</dt><dd>${po.suppliers?.name ?? '—'}${po.suppliers?.phone ? html` · ${po.suppliers.phone}` : ''}</dd>
          <dt>Warehouse</dt><dd>${po.warehouses?.name ?? ''}</dd>
          <dt>Deliver by</dt><dd>${formatDate(po.expected_date)}</dd>
          ${po.approved_at ? html`<dt>Approved</dt><dd>${formatDateTime(po.approved_at)}</dd>` : ''}
          ${po.notes ? html`<dt>Notes</dt><dd>${po.notes}</dd>` : ''}
        </dl>
        <div class="table-wrap"><table class="table small-table">
          <thead><tr><th>Product</th><th class="right">Ordered</th><th class="right">Unit cost</th><th class="right">Received</th><th class="right">Rejected</th><th class="right">Outstanding</th></tr></thead>
          <tbody>${lines.map((i) => html`<tr><td>${i.products?.name ?? ''}<div class="muted tiny">${i.products?.sku ?? ''}</div></td>
            <td class="right num">${formatQty(i.qty_ordered)} ${i.products?.unit ?? ''}</td>
            <td class="right num">${i.unit_cost != null ? formatINR(i.unit_cost) : '—'}</td>
            <td class="right num">${formatQty(i.qty_received)}</td><td class="right num">${Number(i.qty_rejected) > 0 ? formatQty(i.qty_rejected) : '—'}</td>
            <td class="right num ${i.outstanding > 0 ? 'money' : 'muted'}">${formatQty(i.outstanding)}</td></tr>`)}</tbody>
          <tfoot><tr><td class="right muted" colspan="2">Value</td><td class="right num" colspan="4">${t.value > 0 ? formatINR(t.value) : '—'}</td></tr></tfoot></table></div>
        <div class="row" style="justify-content:flex-end;margin-top:var(--space-4);flex-wrap:wrap">
          <a class="btn" target="_blank" rel="noopener" href="${webRoot}po.html?po=${po.id}">Print / PDF</a>
          ${po.status !== 'draft' && po.status !== 'cancelled' ? html`<a class="btn" target="_blank" rel="noopener" href="${whatsappLink(po.suppliers?.phone, poMessage(po, company))}">Share on WhatsApp</a>` : ''}
          ${po.status === 'draft' && canEdit ? html`<button class="btn" data-edit>Edit</button>` : ''}
          ${po.status === 'draft' && canApprove ? html`<button class="btn primary" data-status="sent">Approve &amp; send</button>` : ''}
          ${open && canReceive && lines.some((i) => i.outstanding > 0) ? html`<button class="btn primary" data-receive>Receive goods</button>` : ''}
          ${open && canEdit ? html`<button class="btn" data-status="closed">Close short</button>` : ''}
          ${(po.status === 'draft' || po.status === 'sent') && canEdit && t.received === 0 ? html`<button class="btn danger" data-status="cancelled">Cancel</button>` : ''}
        </div>`);

      on(el, 'click', '[data-status]', async (_e, b) => {
        const next = b.dataset.status;
        const words = { sent: ['Approve and send this purchase order to the supplier?', 'Approve & send', false], closed: ['Close this purchase order with the outstanding quantity left unfilled?', 'Close short', false], cancelled: ['Cancel this purchase order?', 'Cancel order', true] }[next];
        if (!(await confirmDialog(words[0], { confirmText: words[1], danger: words[2] }))) return;
        try { await setPurchaseOrderStatus(po.id, next); toast(`${po.po_number} ${PO_STATUSES[next].label.toLowerCase()}`, 'success'); close(); await reload(); }
        catch (error) { reportError(error); }
      });
      on(el, 'click', '[data-edit]', () => { close(); poForm(po, { suppliers, warehouses, products, me }, reload); });
      on(el, 'click', '[data-receive]', () => { close(); receiveForm({ products, suppliers, warehouses, po }, reload); });
    } catch (error) { close(); reportError(error); }
  }

  draw();
}

/** Create or edit (draft only). Costs default from the supplier's rate card when the line's cost is left blank. */
function poForm(po, { suppliers, warehouses, products, me }, onSaved) {
  const lines = po
    ? po.purchase_order_items.map((i) => ({ product_id: i.product_id, quantity: i.qty_ordered, unit_cost: i.unit_cost ?? '' }))
    : [{ product_id: '', quantity: '', unit_cost: '' }];
  let rates = [];
  const { el, close } = openModal(html`<form id="po-form" class="stack" novalidate></form>`, { title: po ? `Edit ${po.po_number}` : 'New purchase order', wide: true });
  const form = $('#po-form', el);
  const rateFor = (supplierId, productId) => rates.find((r) => r.supplier_id === supplierId && r.product_id === productId);

  function draw() {
    const supplierId = form.elements.supplier?.value ?? po?.supplier_id ?? '';
    mount(form, html`
      <div class="form-grid">
        <label class="field"><span class="label">Supplier</span><select class="select" name="supplier" required ${po ? 'disabled' : ''}>
          <option value="">Choose…</option>${suppliers.filter((s) => s.is_active || s.id === po?.supplier_id).map((s) => html`<option value="${s.id}" ${s.id === (supplierId || po?.supplier_id) ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label class="field"><span class="label">Deliver to</span><select class="select" name="warehouse" required ${po ? 'disabled' : ''}>
          ${warehouses.map((w) => html`<option value="${w.id}" ${w.id === (po?.warehouse_id ?? me.profile.warehouse_id) || (!po && !me.profile.warehouse_id && w.is_default) ? 'selected' : ''}>${w.name}</option>`)}</select></label>
        <label class="field"><span class="label">Deliver by</span><input class="input" name="expected_date" type="date" value="${po?.expected_date ?? ''}"></label>
        <label class="field"><span class="label">Note to the supplier</span><input class="input" name="notes" value="${po?.notes ?? ''}" maxlength="300"></label>
      </div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="right">Quantity</th><th class="right">Unit cost (₹)</th><th></th></tr></thead>
        <tbody>${lines.map((line, i) => { const rate = rateFor(supplierId, line.product_id); return html`<tr data-line="${i}">
          <td><select class="select small" data-field="product_id" required><option value="">Choose product…</option>
            ${products.filter((p) => p.is_active).map((p) => html`<option value="${p.id}" ${p.id === line.product_id ? 'selected' : ''}>${p.name} (${p.unit})</option>`)}</select></td>
          <td><input class="input small num right" type="number" min="0.01" step="any" data-field="quantity" value="${line.quantity}" required style="width:110px"></td>
          <td><input class="input small num right" type="number" min="0" step="0.01" data-field="unit_cost" value="${line.unit_cost}" placeholder="${rate ? Number(rate.price) : 'rate card'}" style="width:120px">
            ${rate ? html`<div class="muted tiny">card ${formatINR(rate.price)} · MOQ ${formatQty(rate.moq)}</div>` : ''}</td>
          <td class="right"><button type="button" class="btn ghost small" data-remove="${i}" ${lines.length === 1 ? 'disabled' : ''}>✕</button></td></tr>`; })}
        </tbody></table></div>
      <div><button type="button" class="btn small" id="add-line">+ Add line</button></div>
      <p class="form-error" id="po-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${po ? 'Save draft' : 'Create draft'}</button></div>`);
  }

  async function loadRates(supplierId) {
    try { rates = supplierId ? await listSupplierProducts({ supplierId }) : []; } catch { rates = []; }
    draw();
  }
  on(form, 'change', '[name=supplier]', (_e, el) => loadRates(el.value));
  on(form, 'change', '[data-field]', (_e, input) => {
    lines[Number(input.closest('[data-line]').dataset.line)][input.dataset.field] = input.value;
    if (input.dataset.field === 'product_id') draw();
  });
  on(form, 'click', '#add-line', () => { lines.push({ product_id: '', quantity: '', unit_cost: '' }); draw(); });
  on(form, 'click', '[data-remove]', (_e, b) => { lines.splice(Number(b.dataset.remove), 1); draw(); });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const items = lines.filter((l) => l.product_id && Number(l.quantity) > 0)
      .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: l.unit_cost === '' ? null : Number(l.unit_cost) }));
    if (!items.length) { $('#po-error', el).textContent = 'Add at least one product with a quantity.'; return; }
    if (!po && !form.elements.supplier.value) { $('#po-error', el).textContent = 'Choose a supplier.'; return; }
    try {
      await withBusy($('button[type="submit"]', form), () => po
        ? updatePurchaseOrder(po.id, { expectedDate: form.elements.expected_date.value, notes: form.elements.notes.value, items })
        : createPurchaseOrder({ supplierId: form.elements.supplier.value, warehouseId: form.elements.warehouse.value, expectedDate: form.elements.expected_date.value, notes: form.elements.notes.value, items }));
      toast(po ? 'Draft saved' : 'Draft created — approve to send it', 'success');
      close(); onSaved();
    } catch (error) { $('#po-error', el).textContent = error.message; }
  };
  draw();
  if (po?.supplier_id) loadRates(po.supplier_id);
}
