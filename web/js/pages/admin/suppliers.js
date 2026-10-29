// =============================================================================
// suppliers.js — Procurement → Suppliers admin screen.
//
// Lists and manages supplier accounts. Admins can create suppliers, invite
// them to the supplier portal, and manage the products they supply.
// =============================================================================

import { html, mount, on, toast, modal, badge } from '../../core/ui.js';
import { listSuppliers, saveSupplier, inviteSupplier, listSupplierProducts, saveSupplierProduct, listCities } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { SUPPLIER_STATUSES } from '../../core/config.js';

/** Render the Suppliers screen. Route: #suppliers */
export async function renderSuppliers(container, me) {
  mount(container, html`
    <div class="page-header">
      <h2>Suppliers</h2>
      ${can(me, 'procurement', 'edit') ? html`<button class="btn btn-primary" id="new-supplier-btn">+ New supplier</button>` : ''}
    </div>
    <div class="filters row gap-sm mb-md">
      <select id="status-filter">
        <option value="">All statuses</option>
        ${Object.entries(SUPPLIER_STATUSES).map(([k, v]) => `<option value="${k}">${v.label}</option>`)}
      </select>
      <input type="search" id="search-input" placeholder="Search by name…" class="input-sm">
    </div>
    <div id="suppliers-list"><div class="loading">Loading…</div></div>
  `);

  let allRows = [];
  on(container, '#new-supplier-btn', 'click', () => openSupplierForm(null, me, reload));
  on(container, '#status-filter', 'change', () => applyFilter());
  on(container, '#search-input', 'input', () => applyFilter());

  await reload();

  async function reload() {
    allRows = await listSuppliers().catch(e => { toast(e.message, 'error'); return []; });
    applyFilter();
  }

  function applyFilter() {
    const status = container.querySelector('#status-filter')?.value ?? '';
    const search = (container.querySelector('#search-input')?.value ?? '').toLowerCase();
    let rows = allRows;
    if (status) rows = rows.filter(r => r.status === status);
    if (search) rows = rows.filter(r => r.name.toLowerCase().includes(search));
    renderList(rows);
  }

  function renderList(rows) {
    const el = container.querySelector('#suppliers-list');
    if (!rows.length) { mount(el, html`<p class="muted">No suppliers found.</p>`); return; }

    mount(el, html`
      <table class="data-table">
        <thead><tr>
          <th>Name</th><th>Contact</th><th>Phone</th><th>GSTIN</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(s => {
          const st = SUPPLIER_STATUSES[s.status] ?? { label: s.status, badge: 'pending' };
          return html`
            <tr>
              <td><strong>${s.name}</strong></td>
              <td>${s.contact_name ?? '—'}</td>
              <td>${s.phone ?? '—'}</td>
              <td class="mono">${s.gstin ?? '—'}</td>
              <td>${badge(st.label, st.badge)}</td>
              <td class="actions">
                ${can(me, 'procurement', 'edit') ? html`
                  <button class="btn btn-sm" data-edit="${s.id}">Edit</button>
                  ${s.portal_email && s.status === 'pending' ? html`<button class="btn btn-sm" data-invite="${s.id}">Invite</button>` : ''}
                ` : ''}
                <button class="btn btn-sm" data-products="${s.id}" data-name="${s.name}">Products</button>
              </td>
            </tr>
          `;
        }).join('')}</tbody>
      </table>
    `);

    on(el, '[data-edit]', 'click', e => {
      const s = allRows.find(r => r.id === e.target.dataset.edit);
      if (s) openSupplierForm(s, me, reload);
    });

    on(el, '[data-invite]', 'click', async e => {
      const id = e.target.dataset.invite;
      try {
        await inviteSupplier(id);
        toast('Invitation sent');
      } catch (err) { toast(err.message, 'error'); }
    });

    on(el, '[data-products]', 'click', e => {
      openSupplierProducts(e.target.dataset.products, e.target.dataset.name, me);
    });
  }
}

async function openSupplierForm(supplier, me, onSave) {
  const cities = await listCities().catch(() => []);

  modal(html`
    <h3>${supplier ? 'Edit supplier' : 'New supplier'}</h3>
    <form id="supplier-form">
      <label>Name * <input name="name" type="text" required value="${supplier?.name ?? ''}"></label>
      <label>Contact name <input name="contact_name" type="text" value="${supplier?.contact_name ?? ''}"></label>
      <div class="form-row">
        <label>Phone <input name="phone" type="tel" value="${supplier?.phone ?? ''}"></label>
        <label>Email <input name="email" type="email" value="${supplier?.email ?? ''}"></label>
      </div>
      <label>Portal login email (for supplier invite)
        <input name="portal_email" type="email" value="${supplier?.portal_email ?? ''}">
      </label>
      <label>City
        <select name="city_id">
          <option value="">— optional —</option>
          ${cities.map(c => `<option value="${c.id}" ${supplier?.city_id === c.id ? 'selected' : ''}>${c.name}</option>`)}
        </select>
      </label>
      <label>Address <textarea name="address">${supplier?.address ?? ''}</textarea></label>
      <label>GSTIN <input name="gstin" type="text" maxlength="15" value="${supplier?.gstin ?? ''}"></label>
      <label>Status
        <select name="status">
          ${Object.entries(SUPPLIER_STATUSES).map(([k, v]) => `<option value="${k}" ${(supplier?.status ?? 'pending') === k ? 'selected' : ''}>${v.label}</option>`)}
        </select>
      </label>
      <label>Notes <textarea name="notes">${supplier?.notes ?? ''}</textarea></label>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save supplier</button>
      </div>
    </form>
  `);

  document.querySelector('#supplier-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await saveSupplier({
        id: supplier?.id,
        name: f.get('name'), contact_name: f.get('contact_name') || null,
        phone: f.get('phone') || null, email: f.get('email') || null,
        portal_email: f.get('portal_email') || null,
        city_id: f.get('city_id') || null, address: f.get('address') || null,
        gstin: f.get('gstin') || null, status: f.get('status'), notes: f.get('notes') || null,
      });
      toast('Supplier saved');
      document.querySelector('.modal-overlay')?.remove();
      onSave();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function openSupplierProducts(supplierId, supplierName, me) {
  const rows = await listSupplierProducts(supplierId).catch(e => { toast(e.message, 'error'); return []; });

  modal(html`
    <h3>${supplierName} — Products</h3>
    ${can(me, 'procurement', 'edit') ? html`<button class="btn btn-primary mb-md" id="add-sp-btn">+ Add product</button>` : ''}
    ${!rows.length ? html`<p class="muted">No products linked yet.</p>` : html`
      <table class="data-table">
        <thead><tr><th>Product</th><th>Supplier SKU</th><th>Unit cost ₹</th><th>MOQ</th><th>Lead days</th></tr></thead>
        <tbody>${rows.map(r => html`
          <tr>
            <td>${r.products?.name ?? r.product_id}</td>
            <td class="mono">${r.supplier_sku ?? '—'}</td>
            <td>${r.unit_cost}</td>
            <td>${r.moq ?? 1}</td>
            <td>${r.lead_days ?? 1}</td>
          </tr>
        `)}</tbody>
      </table>
    `}
  `);

  document.querySelector('#add-sp-btn')?.addEventListener('click', () => {
    // Inline sub-form for adding a product link
    const f = document.createElement('form');
    f.id = 'sp-form';
    f.innerHTML = `
      <label>Product ID <input name="product_id" required placeholder="UUID"></label>
      <label>Supplier SKU <input name="supplier_sku"></label>
      <div class="form-row">
        <label>Unit cost ₹ <input name="unit_cost" type="number" min="0" step="0.01" required></label>
        <label>MOQ <input name="moq" type="number" min="1" value="1"></label>
        <label>Lead days <input name="lead_days" type="number" min="1" value="1"></label>
      </div>
      <button type="submit" class="btn btn-primary mt-sm">Add</button>
    `;
    document.querySelector('.modal-overlay .modal-body')?.appendChild(f);
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fd = new FormData(f);
      try {
        await saveSupplierProduct({
          supplierId, productId: fd.get('product_id'),
          supplierSku: fd.get('supplier_sku') || null,
          unitCost: fd.get('unit_cost'), moq: fd.get('moq'), leadDays: fd.get('lead_days'),
        });
        toast('Product linked');
        document.querySelector('.modal-overlay')?.remove();
        openSupplierProducts(supplierId, supplierName, me);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}
