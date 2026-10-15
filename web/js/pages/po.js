// =============================================================================
// po.js — printable purchase order for one PO (?po=<uuid>), to print or save
// as PDF for the supplier. Staff only: Row Level Security decides whether the
// PO can be read at all (procurement:view, within scope).
// =============================================================================

import { html, mount, $, formatINR, formatQty, formatDate, formatDateTime } from '../core/ui.js';
import { loadCurrentUser, loginFor } from '../core/auth.js';
import { getPurchaseOrder, getCompanySettings } from '../core/api.js';
import { PO_STATUSES } from '../core/config.js';
import { poTotals } from '../core/procurement.js';

const root = $('#invoice');
const poId = new URLSearchParams(location.search).get('po');

async function render() {
  const me = await loadCurrentUser();
  if (!me?.profile) { location.replace(loginFor('admin')); return; }

  const [po, company] = await Promise.all([getPurchaseOrder(poId), getCompanySettings()]);
  if (!po) { mount(root, html`<div class="empty"><strong>Purchase order not found</strong>It may be outside your scope.</div>`); return; }
  const t = poTotals(po.purchase_order_items);

  document.title = `${po.po_number} — ${company.name}`;
  mount(root, html`
    <div class="invoice-head">
      <div><h1>${company.name}</h1>
        <div class="muted small">${company.address}</div>
        <div class="muted small">${company.phone ? html`${company.phone} · ` : ''}${company.email}</div>
        <div class="small">${company.gstin ? html`GSTIN ${company.gstin}` : ''}${company.fssai ? html` · FSSAI ${company.fssai}` : ''}</div></div>
      <div class="right"><h2>Purchase Order</h2>
        <div><strong>${po.po_number}</strong> <span class="badge ${PO_STATUSES[po.status]?.badge ?? ''}">${PO_STATUSES[po.status]?.label ?? po.status}</span></div>
        <div class="muted small">Raised ${formatDate(po.created_at)}${po.approved_at ? html` · approved ${formatDate(po.approved_at)}` : ''}</div>
        <div class="muted small">Deliver by ${formatDate(po.expected_date)}</div></div>
    </div>

    <div class="parties">
      <div><h3>Supplier</h3><strong>${po.suppliers?.name ?? '—'}</strong>
        <div class="small muted">${po.suppliers?.contact ?? ''}${po.suppliers?.phone ? html` · ${po.suppliers.phone}` : ''}</div></div>
      <div><h3>Deliver to</h3><strong>${po.warehouses?.name ?? ''}</strong><div class="small">${po.warehouses?.address ?? ''}</div></div>
    </div>

    <table class="table">
      <thead><tr><th>#</th><th>Item</th><th class="right">Quantity</th><th class="right">Unit cost</th><th class="right">Amount</th></tr></thead>
      <tbody>${po.purchase_order_items.map((i, n) => html`<tr>
        <td class="muted">${n + 1}</td><td>${i.products?.name ?? ''}<div class="muted tiny">${i.products?.sku ?? ''}</div></td>
        <td class="right num">${formatQty(i.qty_ordered)} ${i.products?.unit ?? ''}</td>
        <td class="right num">${i.unit_cost != null ? formatINR(i.unit_cost) : '—'}</td>
        <td class="right num">${i.unit_cost != null ? formatINR(Number(i.qty_ordered) * Number(i.unit_cost)) : '—'}</td></tr>`)}</tbody>
    </table>

    <table class="table totals">
      <tr><td><strong>Total (before GST)</strong></td><td class="right money" style="font-size:var(--text-lg)">${t.value > 0 ? formatINR(t.value) : '—'}</td></tr>
    </table>

    ${po.notes ? html`<p class="small" style="margin-top:var(--space-4)"><strong>Notes:</strong> ${po.notes}</p>` : ''}
    <p class="invoice-note">Please deliver by the date above and quote ${po.po_number} on your invoice. Rejected goods at receiving are returned at the supplier's cost. · Generated ${formatDateTime(new Date().toISOString())}</p>`);
}

render().catch((error) => {
  console.error(error);
  mount(root, html`<div class="banner error">${error.message}</div>`);
});
