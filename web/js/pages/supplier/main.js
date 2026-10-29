// web/js/pages/supplier/main.js
// Supplier portal — dashboard, my products, purchase orders
import { getSupabase } from '../../core/supabase.js';
import { on, html, showToast } from '../../core/ui.js';

const ROOT    = document.getElementById('root');
const VIEW    = document.getElementById('view');
let   me      = null;   // supplier profile row

// ── Auth guard ──────────────────────────────────────────────────────────────
async function boot() {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace('/supplier/login.html'); return; }

  // Load supplier profile
  const { data: profile } = await sb
    .from('supplier_profiles')
    .select('*, supplier:suppliers(*)')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (!profile) {
    ROOT.innerHTML = `<div class="error-page"><p>No supplier profile linked to this account. Contact support.</p>
      <button id="logout-btn" class="btn btn-secondary">Sign out</button></div>`;
    document.getElementById('logout-btn').addEventListener('click', () => {
      sb.auth.signOut().then(() => location.replace('/supplier/login.html'));
    });
    return;
  }

  me = profile;
  renderShell();
  route();

  window.addEventListener('hashchange', route);
}

// ── Shell ────────────────────────────────────────────────────────────────────
function renderShell() {
  ROOT.innerHTML = html`
    <header class="app-header">
      <div class="app-header-inner">
        <a href="#dashboard" class="app-brand">
          <img src="/icons/icon-192.png" alt="" width="28" height="28">
          <span>Fresh Supply</span>
        </a>
        <nav class="app-nav" id="main-nav">
          <a href="#dashboard" class="nav-link">Dashboard</a>
          <a href="#products"  class="nav-link">My Products</a>
          <a href="#orders"    class="nav-link">Purchase Orders</a>
        </nav>
        <div class="header-right">
          <span class="header-user">${me.supplier.name}</span>
          <button id="logout-btn" class="btn btn-ghost btn-sm">Sign Out</button>
        </div>
      </div>
    </header>
    <main id="view" class="page-content"></main>
  `;

  on(ROOT, 'click', '#logout-btn', () => {
    getSupabase().auth.signOut().then(() => location.replace('/supplier/login.html'));
  });

  highlightNav();
}

function highlightNav() {
  const hash = location.hash || '#dashboard';
  ROOT.querySelectorAll('.nav-link').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  });
}

// ── Router ───────────────────────────────────────────────────────────────────
function route() {
  highlightNav();
  const c = document.getElementById('view');
  if (!c) return;
  const hash = location.hash || '#dashboard';
  const routes = {
    '#dashboard': renderDashboard,
    '#products':  renderProducts,
    '#orders':    renderOrders,
  };
  const handler = routes[hash] || renderDashboard;
  handler(c);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function renderDashboard(c) {
  c.innerHTML = `<div class="spinner">Loading…</div>`;
  const sb = getSupabase();

  const [{ data: products }, { data: orders }] = await Promise.all([
    sb.from('supplier_products').select('id', { count: 'exact' }).eq('supplier_id', me.supplier_id),
    sb.from('procurement_orders')
      .select('id, status, total_amount, created_at')
      .eq('supplier_id', me.supplier_id)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const pending = (orders || []).filter((o) => o.status === 'pending').length;
  const total   = (orders || []).reduce((s, o) => s + Number(o.total_amount || 0), 0);

  c.innerHTML = html`
    <div class="page-header">
      <h2>Welcome back, ${me.supplier.name}</h2>
    </div>
    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-label">Listed Products</div>
        <div class="kpi-value">${(products || []).length}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Pending Orders</div>
        <div class="kpi-value">${pending}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Revenue (last 5)</div>
        <div class="kpi-value">₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
      </div>
    </div>

    <section class="section">
      <h3>Recent Purchase Orders</h3>
      ${(orders || []).length === 0
        ? `<p class="empty-state">No purchase orders yet.</p>`
        : `<table class="data-table">
            <thead><tr><th>Order ID</th><th>Status</th><th>Amount</th><th>Date</th></tr></thead>
            <tbody>
              ${(orders || []).map((o) => `
                <tr>
                  <td><a href="#orders" class="link">${o.id.slice(0, 8)}</a></td>
                  <td><span class="badge badge-${o.status}">${o.status}</span></td>
                  <td>₹${Number(o.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                  <td>${new Date(o.created_at).toLocaleDateString('en-IN')}</td>
                </tr>`)}
            </tbody>
          </table>`}
    </section>
  `;
}

// ── Products ──────────────────────────────────────────────────────────────────
async function renderProducts(c) {
  c.innerHTML = `<div class="spinner">Loading…</div>`;
  const sb = getSupabase();

  const { data: prods, error } = await sb
    .from('supplier_products')
    .select('*, product:products(name, sku)')
    .eq('supplier_id', me.supplier_id)
    .order('created_at', { ascending: false });

  if (error) { c.innerHTML = `<p class="error">${error.message}</p>`; return; }

  c.innerHTML = html`
    <div class="page-header">
      <h2>My Products</h2>
      <button class="btn btn-primary" id="add-product-btn">+ Add Product</button>
    </div>
    <table class="data-table" id="products-table">
      <thead>
        <tr>
          <th>Product</th><th>SKU</th><th>Your Price (₹)</th>
          <th>Lead Days</th><th>Min Qty</th><th>Active</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${(prods || []).map((p) => `
          <tr data-id="${p.id}">
            <td>${p.product?.name || '—'}</td>
            <td>${p.product?.sku || '—'}</td>
            <td>₹${Number(p.unit_price || 0).toFixed(2)}</td>
            <td>${p.lead_days ?? '—'}</td>
            <td>${p.min_qty ?? 1}</td>
            <td>${p.active ? '✅' : '❌'}</td>
            <td><button class="btn btn-ghost btn-sm edit-prod-btn" data-id="${p.id}">Edit</button></td>
          </tr>`)}
      </tbody>
    </table>

    <!-- product modal -->
    <dialog id="product-modal" class="modal">
      <div class="modal-inner">
        <h3 id="product-modal-title">Add Product</h3>
        <form id="product-form">
          <input type="hidden" id="pf-id">
          <div class="form-group">
            <label>Product</label>
            <select id="pf-product-id" required></select>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Unit Price (₹)</label>
              <input id="pf-price" type="number" step="0.01" min="0" required>
            </div>
            <div class="form-group">
              <label>Lead Days</label>
              <input id="pf-lead" type="number" min="0" value="1">
            </div>
            <div class="form-group">
              <label>Min Qty</label>
              <input id="pf-min" type="number" min="1" value="1">
            </div>
          </div>
          <div class="form-check">
            <input id="pf-active" type="checkbox" checked>
            <label for="pf-active">Active</label>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="cancel-product">Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      </div>
    </dialog>
  `;

  // Load catalogue products for dropdown
  const { data: catProds } = await sb
    .from('products')
    .select('id, name, sku')
    .eq('active', true)
    .order('name');

  const sel = document.getElementById('pf-product-id');
  (catProds || []).forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.sku})`;
    sel.appendChild(opt);
  });

  const modal = document.getElementById('product-modal');

  function openModal(prod = null) {
    document.getElementById('pf-id').value       = prod?.id || '';
    document.getElementById('pf-product-id').value = prod?.product_id || '';
    document.getElementById('pf-price').value    = prod?.unit_price || '';
    document.getElementById('pf-lead').value     = prod?.lead_days ?? 1;
    document.getElementById('pf-min').value      = prod?.min_qty ?? 1;
    document.getElementById('pf-active').checked = prod ? prod.active : true;
    document.getElementById('product-modal-title').textContent = prod ? 'Edit Product' : 'Add Product';
    modal.showModal();
  }

  on(c, 'click', '#add-product-btn', () => openModal());
  on(c, 'click', '.edit-prod-btn', async (e) => {
    const id = e.target.dataset.id;
    const { data: p } = await sb.from('supplier_products').select('*').eq('id', id).single();
    if (p) openModal(p);
  });
  on(c, 'click', '#cancel-product', () => modal.close());

  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      supplier_id:  me.supplier_id,
      product_id:   document.getElementById('pf-product-id').value,
      unit_price:   parseFloat(document.getElementById('pf-price').value),
      lead_days:    parseInt(document.getElementById('pf-lead').value, 10),
      min_qty:      parseInt(document.getElementById('pf-min').value, 10),
      active:       document.getElementById('pf-active').checked,
    };
    const id = document.getElementById('pf-id').value;
    const { error } = id
      ? await sb.from('supplier_products').update(payload).eq('id', id)
      : await sb.from('supplier_products').insert(payload);

    if (error) { showToast(error.message, 'error'); return; }
    modal.close();
    showToast('Product saved', 'success');
    renderProducts(c);
  });
}

// ── Purchase Orders ───────────────────────────────────────────────────────────
async function renderOrders(c) {
  c.innerHTML = `<div class="spinner">Loading…</div>`;
  const sb = getSupabase();

  const { data: orders, error } = await sb
    .from('procurement_orders')
    .select('id, status, total_amount, created_at, notes, items:procurement_order_items(*, product:products(name))')
    .eq('supplier_id', me.supplier_id)
    .order('created_at', { ascending: false });

  if (error) { c.innerHTML = `<p class="error">${error.message}</p>`; return; }

  c.innerHTML = html`
    <div class="page-header"><h2>Purchase Orders</h2></div>
    ${(orders || []).length === 0
      ? `<p class="empty-state">No purchase orders yet.</p>`
      : (orders || []).map((o) => `
        <div class="card po-card">
          <div class="po-header">
            <div>
              <strong>PO #${o.id.slice(0, 8)}</strong>
              <span class="badge badge-${o.status} ml-2">${o.status}</span>
            </div>
            <div class="po-meta">
              ₹${Number(o.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              &nbsp;·&nbsp;
              ${new Date(o.created_at).toLocaleDateString('en-IN')}
            </div>
          </div>
          ${o.notes ? `<p class="po-notes">${o.notes}</p>` : ''}
          <table class="data-table">
            <thead><tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead>
            <tbody>
              ${(o.items || []).map((i) => `
                <tr>
                  <td>${i.product?.name || '—'}</td>
                  <td>${i.quantity}</td>
                  <td>₹${Number(i.unit_price || 0).toFixed(2)}</td>
                  <td>₹${(i.quantity * Number(i.unit_price || 0)).toFixed(2)}</td>
                </tr>`)}
            </tbody>
          </table>
          ${o.status === 'pending'
            ? `<div class="po-actions">
                 <button class="btn btn-primary confirm-po-btn" data-id="${o.id}">Confirm PO</button>
                 <button class="btn btn-ghost reject-po-btn" data-id="${o.id}">Reject</button>
               </div>`
            : ''}
        </div>`)}
  `;

  on(c, 'click', '.confirm-po-btn', async (e) => {
    const id = e.target.dataset.id;
    const { error } = await getSupabase()
      .from('procurement_orders')
      .update({ status: 'confirmed' })
      .eq('id', id)
      .eq('supplier_id', me.supplier_id);   // RLS ensures ownership
    if (error) { showToast(error.message, 'error'); return; }
    showToast('PO confirmed', 'success');
    renderOrders(c);
  });

  on(c, 'click', '.reject-po-btn', async (e) => {
    if (!confirm('Reject this purchase order?')) return;
    const id = e.target.dataset.id;
    const { error } = await getSupabase()
      .from('procurement_orders')
      .update({ status: 'rejected' })
      .eq('id', id)
      .eq('supplier_id', me.supplier_id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('PO rejected', 'success');
    renderOrders(c);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
boot();
