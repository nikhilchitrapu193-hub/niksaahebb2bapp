// =============================================================================
// quotes.js — Orders → Quotes & Standing Orders admin screen.
//
// Admins create quotes (custom proposals) and monitor standing orders (repeat
// schedules). Quotes move through draft → sent → accepted/declined. Standing
// orders are read-only here; the restaurant side manages them.
// =============================================================================

import { html, mount, on, toast, modal, money, badge } from '../../core/ui.js';
import { listQuotes, saveQuote, setQuoteStatus, listStandingOrders, listRestaurants } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { QUOTE_STATUSES, WEEKDAYS } from '../../core/config.js';
export { renderCoupons } from './coupons.js';

/** Render the Quotes & Standing orders screen. Route: #quotes */
export async function renderQuotes(container, me) {
  mount(container, html`
    <div class="page-header">
      <h2>Quotes &amp; Standing orders</h2>
      ${can(me, 'orders', 'edit') ? html`<button class="btn btn-primary" id="new-quote-btn">+ New quote</button>` : ''}
    </div>
    <div class="tabs" id="quotes-tabs">
      <button class="tab active" data-tab="quotes">Quotes</button>
      <button class="tab" data-tab="standing">Standing orders</button>
    </div>
    <div id="tab-quotes"><div class="loading">Loading…</div></div>
    <div id="tab-standing" hidden><div class="loading">Loading…</div></div>
  `);

  on(container, 'click', '.tab', e => {
    container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    const tab = e.target.dataset.tab;
    container.querySelector('#tab-quotes').hidden = tab !== 'quotes';
    container.querySelector('#tab-standing').hidden = tab !== 'standing';
    if (tab === 'standing') loadStanding();
  });

  on(container, 'click', '#new-quote-btn', () => openQuoteForm(null, me, loadQuotes));

  loadQuotes();

  async function loadQuotes() {
    const quotes = await listQuotes().catch(e => { toast(e.message, 'error'); return []; });
    const el = container.querySelector('#tab-quotes');
    if (!quotes.length) { mount(el, html`<p class="muted">No quotes yet.</p>`); return; }

    mount(el, html`
      <table class="data-table">
        <thead><tr>
          <th>Quote #</th><th>Customer</th><th>Items</th><th>Total</th>
          <th>Status</th><th>Valid to</th><th></th>
        </tr></thead>
        <tbody>${quotes.map(q => {
          const total = (q.quote_items || []).reduce((s, i) => s + i.unit_price * i.qty, 0);
          const st = QUOTE_STATUSES[q.status] ?? { label: q.status, badge: 'pending' };
          return html`
            <tr>
              <td><strong>${q.quote_number}</strong></td>
              <td>${q.restaurants?.name ?? '—'}</td>
              <td>${(q.quote_items || []).length}</td>
              <td>${money(total)}</td>
              <td>${badge(st.label, st.badge)}</td>
              <td>${q.expires_at?.slice(0, 10) ?? '—'}</td>
              <td class="actions">
                ${can(me, 'orders', 'edit') ? html`
                  <button class="btn btn-sm" data-edit="${q.id}">Edit</button>
                  ${q.status === 'draft' ? html`<button class="btn btn-sm btn-primary" data-send="${q.id}">Send</button>` : ''}
                  ${q.status === 'sent' ? html`<button class="btn btn-sm" data-expire="${q.id}">Expire</button>` : ''}
                ` : ''}
              </td>
            </tr>
          `;
        })}</tbody>
      </table>
    `);

    on(el, 'click', '[data-edit]', e => {
      const q = quotes.find(x => x.id === e.target.dataset.edit);
      if (q) openQuoteForm(q, me, loadQuotes);
    });

    on(el, 'click', '[data-send]', async e => {
      try { await setQuoteStatus(e.target.dataset.send, 'sent'); toast('Quote sent to customer'); loadQuotes(); }
      catch (err) { toast(err.message, 'error'); }
    });

    on(el, 'click', '[data-expire]', async e => {
      try { await setQuoteStatus(e.target.dataset.expire, 'expired'); toast('Quote marked expired'); loadQuotes(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }

  async function loadStanding() {
    const orders = await listStandingOrders().catch(e => { toast(e.message, 'error'); return []; });
    const el = container.querySelector('#tab-standing');
    if (!orders.length) { mount(el, html`<p class="muted">No standing orders.</p>`); return; }

    const dayLabels = Object.fromEntries(WEEKDAYS.map(d => [d.value, d.label]));

    mount(el, html`
      <table class="data-table">
        <thead><tr>
          <th>Customer</th><th>Outlet</th><th>Label</th><th>Days</th>
          <th>Slot</th><th>Items</th><th>Status</th>
        </tr></thead>
        <tbody>${orders.map(o => html`
          <tr>
            <td>${o.restaurants?.name ?? '—'}</td>
            <td>${o.outlets?.name ?? '—'}</td>
            <td>${o.label ?? '—'}</td>
            <td>${(o.days || []).map(d => dayLabels[d] ?? d).join(', ')}</td>
            <td>${o.slot}</td>
            <td>${(o.standing_order_items || []).length}</td>
            <td>${badge(o.is_active ? 'Active' : 'Paused', o.is_active ? 'delivered' : 'cancelled')}</td>
          </tr>
        `)}</tbody>
      </table>
    `);
  }
}

async function openQuoteForm(quote, me, onSave) {
  const restaurants = await listRestaurants().catch(() => []);

  modal(html`
    <h3>${quote ? 'Edit quote' : 'New quote'}</h3>
    <form id="quote-form">
      <label>Customer *
        <select name="restaurant_id" required>
          <option value="">— select —</option>
          ${restaurants.map(r => html`<option value="${r.id}" ${quote?.restaurant_id === r.id ? 'selected' : ''}>${r.name}</option>`)}
        </select>
      </label>
      <label>Valid for (days)
        <input name="valid_days" type="number" min="1" value="${quote?.valid_days ?? 3}">
      </label>
      <label>Note
        <textarea name="note">${quote?.note ?? ''}</textarea>
      </label>
      <fieldset>
        <legend>Line items</legend>
        <div id="quote-items">
          ${(quote?.quote_items ?? [{ product_id: '', qty: 1, unit_price: 0 }]).map((item, i) => html`
            <div class="form-row quote-item">
              <input name="product_id_${i}" type="text" placeholder="Product ID" value="${item.product_id ?? ''}" required>
              <input name="qty_${i}" type="number" min="0.01" step="0.01" placeholder="Qty" value="${item.qty}" required>
              <input name="price_${i}" type="number" min="0" step="0.01" placeholder="Unit price ₹" value="${item.unit_price}" required>
              <button type="button" class="btn btn-sm remove-item-btn">✕</button>
            </div>
          `)}
        </div>
        <button type="button" class="btn btn-sm" id="add-item-btn">+ Add line</button>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save quote</button>
      </div>
    </form>
  `);

  const form = document.querySelector('#quote-form');
  if (!form) return;

  form.querySelector('#add-item-btn')?.addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'form-row quote-item';
    const idx = form.querySelectorAll('.quote-item').length;
    div.innerHTML = `
      <input name="product_id_${idx}" type="text" placeholder="Product ID" required>
      <input name="qty_${idx}" type="number" min="0.01" step="0.01" placeholder="Qty" required>
      <input name="price_${idx}" type="number" min="0" step="0.01" placeholder="Unit price ₹" required>
      <button type="button" class="btn btn-sm remove-item-btn">✕</button>
    `;
    form.querySelector('#quote-items').appendChild(div);
  });

  on(form, 'click', '.remove-item-btn', e => e.target.closest('.quote-item')?.remove());

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    const items = [];
    let i = 0;
    while (f.get(`product_id_${i}`) !== null) {
      const pid = f.get(`product_id_${i}`);
      if (pid) items.push({ product_id: pid, qty: Number(f.get(`qty_${i}`)), unit_price: Number(f.get(`price_${i}`)) });
      i++;
    }
    try {
      await saveQuote({
        id: quote?.id,
        restaurantId: f.get('restaurant_id'),
        validDays: f.get('valid_days'),
        note: f.get('note'),
        items,
      });
      toast(quote ? 'Quote updated' : 'Quote created');
      document.querySelector('.modal-overlay')?.remove();
      onSave();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
