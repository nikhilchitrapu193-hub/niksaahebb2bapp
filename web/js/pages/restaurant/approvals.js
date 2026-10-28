// =============================================================================
// approvals.js — customer app → Approvals (migration 020). Orders placed by an
// outlet manager that wait for the owner / approver. Approve keeps the order
// 'placed' for the kitchen; Reject cancels it (stock returns). Only accounts
// whose sector (or account) needs approval ever show anything here.
// =============================================================================

import { html, mount, on, formatINR, formatDateTime, formatDate, formatQty, reportError, toast, withBusy } from '../../core/ui.js';
import { listOrders, approveOrder } from '../../core/api.js';
import { DELIVERY_SLOTS, PAYMENT_METHODS } from '../../core/config.js';

export async function renderApprovals(container, state, onCountChange) {
  const orders = (await listOrders({ approvalStatus: 'pending' })).filter((o) => o.status === 'placed');
  onCountChange?.(orders.length);
  const outlets = state.terms?.outlets ?? [];
  const outletName = (o) => outlets.find((x) => x.id === o.outlet_id)?.name ?? '';

  mount(container, html`
    <div class="page-head"><div><h1>Approvals</h1><p>${orders.length ? `${orders.length} order${orders.length === 1 ? '' : 's'} waiting for your sign-off.` : 'Orders placed by your outlet managers wait here for your sign-off.'}</p></div></div>
    ${!state.terms?.can_approve ? html`<div class="banner warn">Only the account owner or an approver can approve orders.</div>` : ''}
    ${orders.length === 0 ? html`<div class="empty"><strong>Nothing to approve</strong>New orders from outlet managers appear here.</div>` : orders.map((o) => html`
      <article class="card order-card" data-order="${o.id}">
        <div class="spread"><div><strong>${o.order_number}</strong> <span class="muted small">· ${formatDateTime(o.created_at)}${outletName(o) ? ` · ${outletName(o)}` : ''}</span></div><span class="money">${formatINR(o.total_amount)}</span></div>
        <div class="muted small" style="margin:var(--space-2) 0">${DELIVERY_SLOTS[o.delivery_slot]?.label ?? ''} ${formatDate(o.delivery_date)} · ${PAYMENT_METHODS[o.payment_method]?.label ?? ''}${o.po_reference ? ` · PO ${o.po_reference}` : ''}${o.notes ? ` · “${o.notes}”` : ''}</div>
        <ul class="small" style="margin:0 0 var(--space-3);padding-left:1.1rem">${o.order_items.map((i) => html`<li>${i.product_name} — ${formatQty(i.quantity)} ${i.unit} · ${formatINR(i.line_total)}</li>`)}</ul>
        ${state.terms?.can_approve ? html`<div class="row" style="justify-content:flex-end;gap:var(--space-2)">
          <input class="input small" data-note="${o.id}" placeholder="Note (optional)" maxlength="280" style="max-width:260px">
          <button class="btn danger" data-reject="${o.id}">Reject</button><button class="btn primary" data-approve="${o.id}">Approve</button></div>` : ''}
      </article>`)}`);

  const act = async (button, id, approve) => {
    const note = container.querySelector(`[data-note="${id}"]`)?.value ?? '';
    try {
      await withBusy(button, () => approveOrder(id, approve, note));
      toast(approve ? 'Order approved — the kitchen can pick it now' : 'Order rejected and cancelled', approve ? 'success' : 'info');
      await renderApprovals(container, state, onCountChange);
    } catch (error) { reportError(error); }
  };
  on(container, 'click', '[data-approve]', (_e, b) => act(b, b.dataset.approve, true));
  on(container, 'click', '[data-reject]', (_e, b) => act(b, b.dataset.reject, false));
}
