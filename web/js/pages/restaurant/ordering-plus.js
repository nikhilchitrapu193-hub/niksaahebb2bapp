// =============================================================================
// ordering-plus.js — restaurant: Standing orders, Quotes & Spend report tabs.
//
// Customers manage their own standing orders (repeat schedules), view and
// accept quotes sent by admin, and see their spend history.
// =============================================================================

import { html, mount, on, toast, modal, money, badge } from '../../core/ui.js';
import {
  listStandingOrders, saveStandingOrder, setStandingOrderActive,
  listQuotes, acceptQuote, declineQuote,
  getMySpendReport, listProducts,
} from '../../core/api.js';
import { WEEKDAYS, QUOTE_STATUSES, DELIVERY_SLOTS } from '../../core/config.js';

/** Render the Ordering Plus section. Route: #ordering-plus (restaurant app) */
export async function renderOrderingPlus(container, me) {
  mount(container, html`
    <div class="page-header"><h2>Orders Plus</h2></div>
    <div class="tabs" id="op-tabs">
      <button class="tab active" data-tab="standing">Standing orders</button>
      <button class="tab" data-tab="quotes">Quotes</button>
      <button class="tab" data-tab="spend">Spend report</button>
    </div>
    <div id="tab-standing"></div>
    <div id="tab-quotes"   hidden></div>
    <div id="tab-spend"    hidden></div>
  `);

  on(container, '.tab', 'click', e => {
    container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    const tab = e.target.dataset.tab;
    ['standing', 'quotes', 'spend'].forEach(t => {
      container.querySelector(`#tab-${t}`).hidden = (t !== tab);
    });
    if (tab === 'quotes') loadQuotes();
    else if (tab === 'spend') loadSpend();
  });

  loadStanding();

  // ---- Standing orders -------------------------------------------------------

  async function loadStanding() {
    const el = container.querySelector('#tab-standing');
    mount(el, html`<div class="loading">Loading…</div>`);

    const orders = await listStandingOrders().catch(e => { toast(e.message, 'error'); return []; });
    const dayLabels = Object.fromEntries(WEEKDAYS.map(d => [d.value, d.label]));

    mount(el, html`
      <div class="page-sub-header">
        <p class="muted">Standing orders place automatically every week on the days you choose.</p>
        <button class="btn btn-primary" id="new-standing-btn">+ New standing order</button>
      </div>
      ${!orders.length ? html`<p class="muted">No standing orders yet.</p>` : html`
        <div class="card-list">
          ${orders.map(o => html`
            <div class="card">
              <div class="card-header">
                <strong>${o.label || 'Standing order'}</strong>
                ${badge(o.is_active ? 'Active' : 'Paused', o.is_active ? 'delivered' : 'cancelled')}
              </div>
              <div class="card-body">
                <p>Days: ${(o.days || []).map(d => dayLabels[d] ?? d).join(', ')}</p>
                <p>Slot: ${DELIVERY_SLOTS[o.slot]?.label ?? o.slot}</p>
                <p>Items: ${(o.standing_order_items || []).length}</p>
                ${o.start_date ? html`<p class="muted">From ${o.start_date.slice(0, 10)}${o.end_date ? ' to ' + o.end_date.slice(0, 10) : ''}</p>` : ''}
              </div>
              <div class="card-footer actions">
                <button class="btn btn-sm" data-edit-so="${o.id}">Edit</button>
                <button class="btn btn-sm ${o.is_active ? 'btn-danger' : 'btn-primary'}" data-toggle-so="${o.id}" data-active="${o.is_active}">
                  ${o.is_active ? 'Pause' : 'Resume'}
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `);

    on(el, '#new-standing-btn', 'click', () => openStandingForm(null, me, loadStanding));

    on(el, '[data-edit-so]', 'click', e => {
      const o = orders.find(x => x.id === e.target.dataset.editSo);
      if (o) openStandingForm(o, me, loadStanding);
    });

    on(el, '[data-toggle-so]', 'click', async e => {
      const id = e.target.dataset.toggleSo;
      const active = e.target.dataset.active === 'true';
      try {
        await setStandingOrderActive(id, !active);
        toast(active ? 'Standing order paused' : 'Standing order resumed');
        loadStanding();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ---- Quotes ----------------------------------------------------------------

  async function loadQuotes() {
    const el = container.querySelector('#tab-quotes');
    mount(el, html`<div class="loading">Loading…</div>`);
    const quotes = await listQuotes().catch(e => { toast(e.message, 'error'); return []; });

    if (!quotes.length) { mount(el, html`<p class="muted">No quotes from us yet.</p>`); return; }

    mount(el, html`
      <div class="card-list">
        ${quotes.map(q => {
          const total = (q.quote_items || []).reduce((s, i) => s + i.unit_price * i.qty, 0);
          const st = QUOTE_STATUSES[q.status] ?? { label: q.status, badge: 'pending' };
          return html`
            <div class="card">
              <div class="card-header">
                <strong>${q.quote_number}</strong>
                ${badge(st.label, st.badge)}
              </div>
              <div class="card-body">
                <p>${(q.quote_items || []).length} item(s) · Total: ${money(total)}</p>
                ${q.note ? html`<p class="muted">${q.note}</p>` : ''}
                ${q.expires_at ? html`<p class="muted">Valid until ${q.expires_at.slice(0, 10)}</p>` : ''}
              </div>
              ${q.status === 'sent' ? html`
                <div class="card-footer actions">
                  <button class="btn btn-primary" data-accept-quote="${q.id}">Accept &amp; order</button>
                  <button class="btn btn-sm btn-danger" data-decline-quote="${q.id}">Decline</button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `);

    on(el, '[data-accept-quote]', 'click', async e => {
      const id = e.target.dataset.acceptQuote;
      try {
        const orderId = await acceptQuote(id);
        toast('Quote accepted — order placed');
        loadQuotes();
      } catch (err) { toast(err.message, 'error'); }
    });

    on(el, '[data-decline-quote]', 'click', async e => {
      const id = e.target.dataset.declineQuote;
      const reason = prompt('Reason for declining? (optional)');
      if (reason === null) return; // cancelled
      try { await declineQuote(id, reason); toast('Quote declined'); loadQuotes(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }

  // ---- Spend report ----------------------------------------------------------

  async function loadSpend() {
    const el = container.querySelector('#tab-spend');
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);

    mount(el, html`
      <div class="filters row gap-sm mb-md">
        <label>From <input type="date" id="spend-from" value="${firstDay}"></label>
        <label>To   <input type="date" id="spend-to"   value="${today}"></label>
        <button class="btn" id="spend-go-btn">Load</button>
      </div>
      <div id="spend-result"><p class="muted">Select a date range and click Load.</p></div>
    `);

    on(el, '#spend-go-btn', 'click', async () => {
      const from = el.querySelector('#spend-from').value;
      const to   = el.querySelector('#spend-to').value;
      const res  = el.querySelector('#spend-result');
      mount(res, html`<div class="loading">Loading…</div>`);
      try {
        const rows = await getMySpendReport({ from, to });
        if (!rows || !rows.length) { mount(res, html`<p class="muted">No orders in this period.</p>`); return; }
        const grandTotal = rows.reduce((s, r) => s + (r.total || 0), 0);
        mount(res, html`
          <table class="data-table">
            <thead><tr><th>Date</th><th>Orders</th><th>Total spend</th></tr></thead>
            <tbody>${rows.map(r => html`
              <tr>
                <td>${r.period ?? r.day ?? '—'}</td>
                <td>${r.orders ?? '—'}</td>
                <td>${money(r.total)}</td>
              </tr>
            `).join('')}
            <tr class="total-row"><td colspan="2"><strong>Total</strong></td><td><strong>${money(grandTotal)}</strong></td></tr>
            </tbody>
          </table>
        `);
      } catch (err) { toast(err.message, 'error'); mount(res, html`<p class="error">${err.message}</p>`); }
    });
  }
}

// ---- Standing order form ----------------------------------------------------

async function openStandingForm(so, me, onSave) {
  const products = await listProducts().catch(() => []);

  const existingItems = so?.standing_order_items ?? [{ product_id: '', qty: 1 }];
  const existingDays  = so?.days ?? [];

  modal(html`
    <h3>${so ? 'Edit standing order' : 'New standing order'}</h3>
    <form id="so-form">
      <label>Label (optional)
        <input name="label" type="text" value="${so?.label ?? ''}" placeholder="e.g. Daily vegetables">
      </label>
      <fieldset>
        <legend>Repeat days</legend>
        <div class="checkbox-group">
          ${WEEKDAYS.map(d => html`
            <label class="checkbox-inline">
              <input type="checkbox" name="days" value="${d.value}" ${existingDays.includes(d.value) ? 'checked' : ''}>
              ${d.label}
            </label>
          `).join('')}
        </div>
      </fieldset>
      <label>Delivery slot
        <select name="slot">
          ${Object.entries(DELIVERY_SLOTS).map(([k, v]) => `<option value="${k}" ${(so?.slot ?? 'morning') === k ? 'selected' : ''}>${v.label} (${v.time})</option>`).join('')}
        </select>
      </label>
      <div class="form-row">
        <label>Start date (optional)
          <input name="start_date" type="date" value="${so?.start_date?.slice(0, 10) ?? ''}">
        </label>
        <label>End date (optional)
          <input name="end_date" type="date" value="${so?.end_date?.slice(0, 10) ?? ''}">
        </label>
      </div>
      <fieldset>
        <legend>Items</legend>
        <div id="so-items">
          ${existingItems.map((item, i) => html`
            <div class="form-row so-item">
              <select name="product_id_${i}" required>
                <option value="${item.product_id ?? ''}">— select product —</option>
                ${products.map(p => `<option value="${p.id}" ${p.id === item.product_id ? 'selected' : ''}>${p.name}</option>`).join('')}
              </select>
              <input name="qty_${i}" type="number" min="0.01" step="0.01" value="${item.qty ?? 1}" required>
              <button type="button" class="btn btn-sm remove-so-item">✕</button>
            </div>
          `).join('')}
        </div>
        <button type="button" class="btn btn-sm" id="add-so-item-btn">+ Add item</button>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save standing order</button>
      </div>
    </form>
  `);

  const form = document.querySelector('#so-form');
  if (!form) return;

  form.querySelector('#add-so-item-btn')?.addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'form-row so-item';
    const idx = form.querySelectorAll('.so-item').length;
    div.innerHTML = `
      <select name="product_id_${idx}" required>
        <option value="">— select product —</option>
        ${products.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
      </select>
      <input name="qty_${idx}" type="number" min="0.01" step="0.01" value="1" required>
      <button type="button" class="btn btn-sm remove-so-item">✕</button>
    `;
    form.querySelector('#so-items')?.appendChild(div);
  });

  on(form, '.remove-so-item', 'click', e => e.target.closest('.so-item')?.remove());

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    const days = [...form.querySelectorAll('[name="days"]:checked')].map(el => Number(el.value));
    if (!days.length) { toast('Select at least one day', 'error'); return; }

    const items = [];
    let i = 0;
    while (f.get(`product_id_${i}`) !== null) {
      const pid = f.get(`product_id_${i}`);
      if (pid) items.push({ product_id: pid, qty: Number(f.get(`qty_${i}`)) });
      i++;
    }
    if (!items.length) { toast('Add at least one item', 'error'); return; }

    try {
      await saveStandingOrder({
        id: so?.id, items, days,
        slot: f.get('slot'), label: f.get('label') || null,
        startDate: f.get('start_date') || null, endDate: f.get('end_date') || null,
      });
      toast(so ? 'Standing order updated' : 'Standing order created');
      document.querySelector('.modal-overlay')?.remove();
      onSave();
    } catch (err) { toast(err.message, 'error'); }
  });
}
