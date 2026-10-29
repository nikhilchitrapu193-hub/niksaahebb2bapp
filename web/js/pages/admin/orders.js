// =============================================================================
// orders.js — Admin: Orders list and detail
//
// Renders the orders table with inline detail panels. Status transitions go
// through setOrderStatus(); packed quantities go through setPacked(); payment
// recording calls recordPayment() via getCustomerReceivables().
//
// ARCHITECTURE: All Supabase calls go through api.js — never directly here.
// =============================================================================

import { html, mount, on, toast, reportError, withBusy, formatINR, formatDate, statusBadge } from '../../core/ui.js';
import {
  listOrders, setOrderStatus, setPacked,
  getCustomerReceivables, recordPayment, listSectors,
  placeOrderFor, listRestaurants, listProducts,
} from '../../core/api.js';
import { can } from '../../core/permissions.js';

// Status transitions: given current status, what is the next action?
const NEXT_STATUS = {
  placed:            { to: 'confirmed',         label: 'Confirm order' },
  confirmed:         { to: 'packed',            label: 'Mark packed' },
  packed:            { to: 'out_for_delivery',  label: 'Dispatch' },
  out_for_delivery:  { to: 'delivered',         label: 'Mark delivered' },
};

/** Sub-nav shown at the top of the Orders section */
function subNav(activeHash) {
  const tabs = [
    { href: '#orders',  label: 'All Orders' },
    { href: '#quotes',  label: 'Quotes'     },
    { href: '#tickets', label: 'Tickets'    },
    { href: '#issues',  label: 'Issues'     },
  ];
  return html`
    <nav class="sub-nav">
      ${tabs.map((t) =>
        html`<a href="${t.href}" class="sub-nav-link${activeHash === t.href ? ' active' : ''}">${t.label}</a>`
      )}
    </nav>
  `;
}

export async function renderOrders(container, me) {
  mount(container, html`<div class="loading">Loading orders…</div>`);

  // Load sectors once so we can resolve sector_code → name in the detail panel.
  const sectors = await listSectors().catch(() => []);
  const sectorName = (code) => {
    if (!code) return null;
    return sectors.find((s) => s.code === code)?.name ?? code;
  };

  // Filters held in closure so re-renders can apply them.
  let filterStatus = '';
  let filterApproval = '';

  async function reload() {
    const opts = {};
    if (filterStatus) opts.status = filterStatus;
    if (filterApproval) opts.approvalStatus = filterApproval;
    const orders = await listOrders(opts).catch((err) => { reportError(err); return []; });
    renderList(orders);
  }

  mount(container, html`
    ${subNav('#orders')}
    <div class="page-head">
      <div><h1>Orders</h1></div>
      <div class="row gap-2">
      ${can(me, 'orders', 'edit') ? html`<button class="btn primary" id="new-order">+ New order</button>` : ''}
      <div class="filters row gap-2">
        <select class="select-sm" data-filter="status">
          <option value="">All statuses</option>
          <option value="placed">Placed</option>
          <option value="confirmed">Confirmed</option>
          <option value="packed">Packed</option>
          <option value="out_for_delivery">Out for delivery</option>
          <option value="delivered">Delivered</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select class="select-sm" data-filter="approvalStatus">
          <option value="">All approval</option>
          <option value="pending">Awaiting approval</option>
          <option value="not_required">No approval needed</option>
          <option value="approved">Approved</option>
        </select>
      </div>
      </div>
    </div>
    <div id="po-for" hidden class="card card-pad mb-md">
      <h3>Place order for a restaurant</h3>
      <form id="po-form" class="stack" novalidate>
        <label class="field"><span class="label">Restaurant</span>
          <input class="input" name="restaurant" list="po-restaurant-list" placeholder="Restaurant name or ID" required>
          <datalist id="po-restaurant-list"></datalist>
        </label>
        <div id="po-items">
          <div class="po-item row gap-2">
            <input class="input" data-field="product_id" list="po-product-list" placeholder="Product name or ID" required>
            <datalist id="po-product-list"></datalist>
            <input class="input" type="number" data-field="quantity" min="1" placeholder="Qty" required>
          </div>
        </div>
        <div class="row gap-2">
          <button class="btn primary" type="submit" id="po-submit">Place order</button>
          <button class="btn ghost" type="button" id="po-cancel">Cancel</button>
        </div>
      </form>
    </div>
    <div id="orders-list"></div>
    <div id="order-detail"></div>
  `);

  on(container, 'change', '[data-filter="status"]', (e) => {
    filterStatus = e.target.value;
    reload();
  });
  on(container, 'change', '[data-filter="approvalStatus"]', (e) => {
    filterApproval = e.target.value;
    reload();
  });

  // New order form
  on(container, 'click', '#new-order', async () => {
    const poFor = container.querySelector('#po-for');
    poFor.hidden = false;
    // Populate selects
    const [restaurants, products] = await Promise.all([
      listRestaurants().catch(() => []),
      listProducts().catch(() => []),
    ]);
    const restList = poFor.querySelector('#po-restaurant-list');
    restaurants.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id; opt.label = r.name;
      restList.appendChild(opt);
    });
    const prodList = poFor.querySelector('#po-product-list');
    products.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id; opt.label = `${p.name} (${p.unit})`;
      prodList.appendChild(opt);
    });
  });

  on(container, 'click', '#po-cancel', () => {
    container.querySelector('#po-for').hidden = true;
  });

  on(container, 'submit', '#po-for', async (e, poFor) => {
    e.preventDefault();
    const restaurantId = poFor.querySelector('[name=restaurant]').value;
    const productId = poFor.querySelector('[data-field="product_id"]').value;
    const quantity = Number(poFor.querySelector('[data-field="quantity"]').value);
    const btn = poFor.querySelector('#po-submit');
    try {
      await withBusy(btn, () => placeOrderFor(restaurantId, [{ product_id: productId, quantity }]));
      toast('Order placed', 'success');
      container.querySelector('#po-for').hidden = true;
      poFor.querySelector('#po-form').reset();
      await reload();
    } catch (err) { reportError(err); }
  });

  function renderList(orders) {
    const listEl = container.querySelector('#orders-list');
    if (!orders.length) {
      mount(listEl, html`<p class="muted">No orders found.</p>`);
      return;
    }

    mount(listEl, html`
      <table class="data-table">
        <thead><tr>
          <th>Order #</th><th>Customer</th><th>Total</th>
          <th>Delivery</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${orders.map((o) => {
            const isPendingApproval = o.approval_status === 'pending';
            const statusText = isPendingApproval ? 'Awaiting approval' : (o.status ?? '');
            return html`
              <tr class="clickable" data-order="${o.id}">
                <td><strong>${o.order_number ?? o.id.slice(0, 8)}</strong></td>
                <td>${o.restaurant_name ?? o.outlets?.name ?? '—'}</td>
                <td>${formatINR(o.total_amount)}</td>
                <td>${o.delivery_date ? formatDate(o.delivery_date) : '—'}${o.delivery_slot ? ' · ' + o.delivery_slot : ''}</td>
                <td>${statusBadge(isPendingApproval ? 'pending_approval' : o.status)} ${isPendingApproval ? html`<span class="muted">${statusText}</span>` : ''}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    `);

    on(listEl, 'click', 'tr.clickable[data-order]', (_, row) => {
      const orderId = row.dataset.order;
      const order = orders.find((o) => o.id === orderId);
      if (order) openDetail(order);
    });
  }

  function openDetail(order) {
    const detailEl = container.querySelector('#order-detail');
    const canEdit = can(me, 'orders', 'edit');
    const nextStep = NEXT_STATUS[order.status];
    const isConfirmed = order.status === 'confirmed';
    const isDeliveredCredit = order.status === 'delivered' && order.payment_method === 'credit' && order.payment_status !== 'paid';
    const isPendingApproval = order.approval_status === 'pending';
    const secName = sectorName(order.sector_code);

    const items = order.order_items ?? [];

    mount(detailEl, html`
      <div class="detail-panel card">
        <div class="between">
          <h3>Order ${order.order_number ?? order.id.slice(0, 8)}</h3>
          <button class="btn ghost small" id="close-detail">✕ Close</button>
        </div>

        ${isPendingApproval ? html`
          <div class="banner warn">
            Awaiting the customer's approval before this order can be confirmed.
            ${order.outlets?.name ? html` — <strong>${order.outlets.name}</strong>` : ''}
          </div>
        ` : ''}

        <dl class="kv">
          <dt>Customer</dt>
          <dd>${order.restaurant_name ?? '—'}${order.outlets?.name ? html` <span class="muted">(${order.outlets.name})</span>` : ''}</dd>

          <dt>Delivery address</dt>
          <dd>${order.delivery_address ?? '—'}</dd>

          ${order.po_reference ? html`<dt>PO reference</dt><dd>${order.po_reference}</dd>` : ''}

          ${order.delivery_fee != null && order.delivery_fee > 0 ? html`
            <dt>Delivery fee</dt><dd>${formatINR(order.delivery_fee)}</dd>
          ` : ''}

          ${secName ? html`<dt>Sector</dt><dd>${secName}</dd>` : ''}

          <dt>Payment</dt>
          <dd>${order.payment_method ?? '—'} · ${order.payment_status ?? '—'}
            ${isDeliveredCredit ? html`
              <span class="muted">${order.due_date ? ` · due ${formatDate(order.due_date)}` : ''}</span>
              ${canEdit ? html`<button class="btn small primary" data-pay style="margin-left:var(--space-2)">Record payment</button>` : ''}
            ` : ''}
          </dd>

          <dt>Total</dt>
          <dd><strong>${formatINR(order.total_amount)}</strong></dd>
        </dl>

        ${items.length ? html`
          <table class="data-table">
            <thead><tr><th>Product</th><th>Qty</th><th>Unit</th><th>Price</th><th>Total</th>
              ${isConfirmed && canEdit ? html`<th>Packed qty</th>` : ''}
            </tr></thead>
            <tbody>
              ${items.map((item) => html`
                <tr>
                  <td>${item.product_name ?? '—'}</td>
                  <td>${item.quantity}</td>
                  <td>${item.unit ?? '—'}</td>
                  <td>${formatINR(item.unit_price)}</td>
                  <td>${formatINR(item.line_total ?? item.quantity * item.unit_price)}</td>
                  ${isConfirmed && canEdit && item.id ? html`
                    <td><input class="input-sm" type="number" min="0" step="0.01"
                      data-packed="${item.id}"
                      data-ordered="${item.ordered_quantity ?? item.quantity}"
                      value="${item.ordered_quantity ?? item.quantity}"
                      style="width:80px"></td>
                  ` : (isConfirmed && canEdit ? html`<td>—</td>` : '')}
                </tr>
              `)}
            </tbody>
          </table>
        ` : ''}

        ${isConfirmed && canEdit ? html`
          <div class="row gap-2" style="margin-top:var(--space-3)">
            <button class="btn primary" data-save-packed>Save packed quantities</button>
          </div>
        ` : ''}

        ${canEdit && nextStep && !isPendingApproval ? html`
          <div class="row gap-2" style="margin-top:var(--space-3)">
            <button class="btn primary" data-next data-to="${nextStep.to}" data-order-id="${order.id}">${nextStep.label}</button>
          </div>
        ` : ''}

        <div id="receipt-area"></div>
      </div>
    `);

    on(detailEl, 'click', '#close-detail', () => mount(detailEl, html``));

    // Advance status
    if (canEdit && nextStep) {
      on(detailEl, 'click', '[data-next]', async (_, btn) => {
        try {
          await withBusy(btn, () => setOrderStatus(order.id, nextStep.to));
          toast(`Order ${nextStep.label.toLowerCase()}`, 'success');
          order.status = nextStep.to;
          await reload();
          openDetail({ ...order, status: nextStep.to });
        } catch (err) { reportError(err); }
      });
    }

    // Save packed quantities
    if (isConfirmed && canEdit) {
      on(detailEl, 'click', '[data-save-packed]', async (_, btn) => {
        const inputs = detailEl.querySelectorAll('[data-packed]');
        // Only send lines where packed qty differs from ordered qty
        const changed = [];
        inputs.forEach((inp) => {
          const packed = parseFloat(inp.value);
          const ordered = parseFloat(inp.dataset.ordered);
          if (!isNaN(packed) && packed !== ordered) {
            changed.push({ order_item_id: inp.dataset.packed, packed_quantity: packed });
          }
        });
        // If nothing changed, send all
        const toSend = changed.length ? changed : [...inputs].map((inp) => ({
          order_item_id: inp.dataset.packed,
          packed_quantity: parseFloat(inp.value) || 0,
        }));
        try {
          await withBusy(btn, () => setPacked(order.id, toSend));
          toast('Packed quantities saved', 'success');
          await reload();
        } catch (err) { reportError(err); }
      });
    }

    // Record payment button → load receivables → show receipt form
    if (isDeliveredCredit && canEdit) {
      on(detailEl, 'click', '[data-pay]', async () => {
        const receiptArea = detailEl.querySelector('#receipt-area');
        mount(receiptArea, html`<div class="loading">Loading account…</div>`);
        try {
          const recv = await getCustomerReceivables(order.restaurant_id);
          const openItems = recv?.open_items ?? [];
          // Pre-tick the invoice for this order
          const amount = openItems.find((i) => i.id === order.id)?.balance ?? order.total_amount ?? 0;

          mount(receiptArea, html`
            <hr>
            <h4>Record payment</h4>
            <form id="receipt" class="stack" novalidate>
              <div class="form-grid">
                <label class="field"><span class="label">Method</span>
                  <select class="select" name="method" required>
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="neft">NEFT</option>
                    <option value="cheque">Cheque</option>
                    <option value="credit_note">Credit note</option>
                  </select></label>
                <label class="field"><span class="label">Amount (₹)</span>
                  <input class="input" name="amount" type="number" min="0" step="0.01"
                    value="${amount}" required></label>
                <label class="field"><span class="label">Reference / UTR</span>
                  <input class="input" name="reference" maxlength="100"></label>
              </div>
              <div>
                <p class="label">Apply to invoices:</p>
                ${openItems.map((item) => html`
                  <label class="checkbox-row">
                    <input type="checkbox" data-item="${item.id}" checked="${item.id === order.id ? 'true' : 'false'}"
                      ${item.id === order.id ? 'checked' : ''} value="${item.balance}">
                    ${item.number ?? item.id} — ${formatINR(item.balance)}
                    ${item.days_overdue > 0 ? html` <span class="badge cancelled">${item.days_overdue}d overdue</span>` : ''}
                  </label>
                `)}
              </div>
              <div><button class="btn primary" type="submit">Record payment</button></div>
            </form>
          `);

          on(receiptArea, 'submit', '#receipt', async (e, form) => {
            e.preventDefault();
            const fd = new FormData(form);
            const allocs = [];
            receiptArea.querySelectorAll('[data-item]:checked').forEach((cb) => {
              allocs.push({ order_id: cb.dataset.item, amount: parseFloat(cb.value) });
            });
            try {
              await recordPayment(order.restaurant_id, {
                amount: parseFloat(fd.get('amount')),
                method: fd.get('method'),
                reference: fd.get('reference') || null,
                allocations: allocs,
              });
              toast('Payment recorded', 'success');
              mount(receiptArea, html``);
              await reload();
            } catch (err) { reportError(err); }
          });
        } catch (err) {
          reportError(err);
          mount(receiptArea, html`<p class="error">Could not load account details.</p>`);
        }
      });
    }
  }

  await reload();
}

