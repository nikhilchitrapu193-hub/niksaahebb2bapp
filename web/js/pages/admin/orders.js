// web/js/pages/admin/orders.js  (CHANGED — P2-2: adds Quotes sub-nav link)
// Renders the orders list. The Quotes tab is a top-level route (#quotes) so
// this file only adds a secondary sub-nav strip to link across.
import { getSupabase } from '../../core/supabase.js';
import { html, mount, on, showToast } from '../../core/ui.js';
import { can } from '../../core/permissions.js';

/** Sub-nav shown at the top of the Orders section */
function subNav(activeHash) {
  const tabs = [
    { href: '#orders',  label: 'All Orders'  },
    { href: '#quotes',  label: 'Quotes'       },   // P2-2
    { href: '#tickets', label: 'Tickets'      },
    { href: '#issues',  label: 'Issues'       },
  ];
  return html`
    <nav class="sub-nav">
      ${tabs.map((t) =>
        `<a href="${t.href}" class="sub-nav-link${activeHash === t.href ? ' active' : ''}">${t.label}</a>`
      ).join('')}
    </nav>
  `;
}

export async function renderOrders(container, me) {
  const sb = getSupabase();
  container.innerHTML = `<div class="spinner">Loading orders…</div>`;

  // Load orders with customer and item count
  const { data: orders, error } = await sb
    .from('orders')
    .select(`
      id, status, total_amount, created_at, delivery_date, delivery_slot,
      outlet:outlets(name, restaurant:restaurants(name)),
      item_count:order_items(count)
    `)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    mount(container, html`<p class="error">${error.message}</p>`);
    return;
  }

  // Status badge colours
  const STATUS_CLASS = {
    pending: 'warning', confirmed: 'info', dispatched: 'info',
    delivered: 'success', cancelled: 'error',
  };

  mount(container, html`
    ${subNav('#orders')}
    <div class="page-header">
      <h2>Orders</h2>
      <div class="page-header-actions">
        <select id="status-filter" class="select-sm">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="dispatched">Dispatched</option>
          <option value="delivered">Delivered</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
    </div>

    <table class="data-table" id="orders-table">
      <thead>
        <tr>
          <th>Order ID</th>
          <th>Restaurant · Outlet</th>
          <th>Items</th>
          <th>Total</th>
          <th>Delivery</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="orders-tbody">
        ${renderRows(orders || [])}
      </tbody>
    </table>

    <!-- Order detail modal -->
    <dialog id="order-modal" class="modal">
      <div class="modal-inner" id="order-modal-inner"></div>
    </dialog>
  `);

  // Filter
  on(container, 'change', '#status-filter', async (e) => {
    const status = e.target.value;
    const query  = sb
      .from('orders')
      .select('id, status, total_amount, created_at, delivery_date, delivery_slot, outlet:outlets(name, restaurant:restaurants(name)), item_count:order_items(count)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (status) query.eq('status', status);
    const { data } = await query;
    document.getElementById('orders-tbody').innerHTML = renderRows(data || []);
  });

  // Open detail
  on(container, 'click', '.view-order-btn', async (e) => {
    const id = e.target.dataset.id;
    await openOrderDetail(id, container, me);
  });

  // Confirm
  on(container, 'click', '.confirm-order-btn', async (e) => {
    const id = e.target.dataset.id;
    const { error: err } = await sb
      .from('orders')
      .update({ status: 'confirmed' })
      .eq('id', id);
    if (err) { showToast(err.message, 'error'); return; }
    showToast('Order confirmed', 'success');
    renderOrders(container, me);
  });

  // Cancel
  on(container, 'click', '.cancel-order-btn', async (e) => {
    const id = e.target.dataset.id;
    if (!confirm('Cancel this order?')) return;
    const { error: err } = await sb
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', id);
    if (err) { showToast(err.message, 'error'); return; }
    showToast('Order cancelled', 'success');
    renderOrders(container, me);
  });
}

function renderRows(orders) {
  if (!orders.length) return `<tr><td colspan="7" class="empty-state">No orders found.</td></tr>`;

  const STATUS_CLASS = {
    pending: 'warning', confirmed: 'info', dispatched: 'info',
    delivered: 'success', cancelled: 'error',
  };

  return orders.map((o) => {
    const restaurant = o.outlet?.restaurant?.name || '—';
    const outlet     = o.outlet?.name || '—';
    const items      = o.item_count?.[0]?.count ?? 0;
    const total      = Number(o.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    const delivery   = o.delivery_date ? `${o.delivery_date}${o.delivery_slot ? ' ' + o.delivery_slot : ''}` : '—';
    const cls        = STATUS_CLASS[o.status] || 'default';

    return `
      <tr>
        <td><code>${o.id.slice(0, 8)}</code></td>
        <td>${restaurant} · ${outlet}</td>
        <td>${items}</td>
        <td>₹${total}</td>
        <td>${delivery}</td>
        <td><span class="badge badge-${cls}">${o.status}</span></td>
        <td class="actions-cell">
          <button class="btn btn-ghost btn-sm view-order-btn" data-id="${o.id}">View</button>
          ${o.status === 'pending'
            ? `<button class="btn btn-primary btn-sm confirm-order-btn" data-id="${o.id}">Confirm</button>
               <button class="btn btn-ghost btn-sm cancel-order-btn" data-id="${o.id}">Cancel</button>`
            : ''}
        </td>
      </tr>
    `;
  }).join('');
}

async function openOrderDetail(orderId, container, me) {
  const sb = getSupabase();
  const modal = document.getElementById('order-modal');
  const inner = document.getElementById('order-modal-inner');
  inner.innerHTML = `<div class="spinner">Loading…</div>`;
  modal.showModal();

  const { data: order, error } = await sb
    .from('orders')
    .select(`
      *, outlet:outlets(name, address, restaurant:restaurants(name)),
      items:order_items(*, product:products(name, sku, unit))
    `)
    .eq('id', orderId)
    .single();

  if (error || !order) {
    inner.innerHTML = `<p class="error">Could not load order.</p>
      <button class="btn btn-secondary" onclick="this.closest('dialog').close()">Close</button>`;
    return;
  }

  inner.innerHTML = html`
    <div class="modal-header">
      <h3>Order #${order.id.slice(0, 8)}</h3>
      <button class="modal-close" onclick="this.closest('dialog').close()">×</button>
    </div>
    <div class="modal-body">
      <dl class="detail-grid">
        <dt>Restaurant</dt><dd>${order.outlet?.restaurant?.name || '—'}</dd>
        <dt>Outlet</dt><dd>${order.outlet?.name || '—'}</dd>
        <dt>Address</dt><dd>${order.outlet?.address || '—'}</dd>
        <dt>Delivery</dt><dd>${order.delivery_date || '—'}${order.delivery_slot ? ' · ' + order.delivery_slot : ''}</dd>
        <dt>Status</dt><dd><span class="badge">${order.status}</span></dd>
        <dt>Notes</dt><dd>${order.notes || '—'}</dd>
      </dl>
      <h4>Items</h4>
      <table class="data-table">
        <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>Unit</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>
          ${(order.items || []).map((i) => `
            <tr>
              <td>${i.product?.name || '—'}</td>
              <td>${i.product?.sku || '—'}</td>
              <td>${i.quantity}</td>
              <td>${i.product?.unit || '—'}</td>
              <td>₹${Number(i.unit_price || 0).toFixed(2)}</td>
              <td>₹${(i.quantity * Number(i.unit_price || 0)).toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="total-row">
        <strong>Total: ₹${Number(order.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="this.closest('dialog').close()">Close</button>
    </div>
  `;
}
