// =============================================================================
// main.js — restaurant app entry: auth guard, header, routes, cart drawer.
// Routes: #catalogue (default) · #orders · #account
// =============================================================================

import { html, mount, $, on, formatINR, reportError, toast, withBusy } from '../../core/ui.js';
import { requireRole } from '../../core/auth.js';
import { renderShell, startRouter } from '../../core/shell.js';
import { listProducts, listCategories, placeOrder } from '../../core/api.js';
import { renderCatalogue } from './catalogue.js';
import { renderOrders } from './orders.js';
import { renderAccount } from './account.js';
import { cartEntries, cartCount, cartTotal, setQty, clearCart, toOrderItems, onCartChange } from './cart.js';
import { isUnavailable } from './catalogue.js';
import { DELIVERY_SLOTS, PAYMENT_METHODS, config } from '../../core/config.js';

/** YYYY-MM-DD for `daysFromNow` days ahead, in India time. */
function isoDate(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const me = await requireRole('restaurant');
if (me) start();

async function start() {
  const state = { me, products: [], categories: [], byId: {} };
  const canOrder = () => state.me.restaurant?.status === 'approved';

  const shell = renderShell({
    me,
    subtitle: me.restaurant?.name ?? 'Restaurant',
    links: [
      { href: '#catalogue', label: 'Catalogue' },
      { href: '#orders', label: 'My orders' },
      { href: '#account', label: 'Account' },
    ],
    extra: html`<button class="btn primary small" id="open-cart">Cart <span id="cart-count">0</span></button>`,
  });

  const view = $('#view');

  async function loadCatalogue() {
    [state.products, state.categories] = await Promise.all([listProducts(), listCategories()]);
    state.byId = Object.fromEntries(state.products.map((p) => [p.id, p]));
  }

  /** Status banner shown above every page until the restaurant is approved. */
  function statusBanner() {
    const status = state.me.restaurant?.status;
    if (status === 'approved') return '';
    const text = status === 'suspended'
      ? 'Your account is suspended. Please contact us to place orders.'
      : 'Your account is awaiting approval. You can browse the catalogue now and order as soon as we approve you.';
    return html`<div class="banner warn">${text}</div>`;
  }

  function withBanner(render) {
    return async (container) => {
      const holder = document.createElement('div');
      container.replaceChildren(holder);
      mount(holder, statusBanner());
      const body = document.createElement('div');
      container.append(body);
      await render(body);
    };
  }

  function updateCartButton() {
    $('#cart-count').textContent = cartCount();
  }
  onCartChange(updateCartButton);
  updateCartButton();

  // ----- Cart drawer -------------------------------------------------------
  function openCart() {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    document.body.append(overlay);
    const close = () => { overlay.remove(); unsubscribe(); };
    const unsubscribe = onCartChange(draw);
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-close]')) close(); });

    // Checkout choices survive re-renders of the drawer.
    const checkout = { slot: 'morning', date: isoDate(1), payment: 'cod', notes: '' };

    function draw() {
      const entries = cartEntries().filter((e) => state.byId[e.productId]);
      const total = cartTotal(state.byId);
      const tax = entries.reduce((sum, { productId, quantity }) => {
        const p = state.byId[productId];
        return sum + Math.round(p.price * quantity * (p.gst_rate || 0)) / 100;
      }, 0);
      mount(overlay, html`
        <aside class="drawer" role="dialog" aria-label="Your cart">
          <div class="drawer-head"><h2>Your cart</h2><button class="icon-btn" data-close aria-label="Close">×</button></div>
          <div class="drawer-body">
            ${entries.length === 0
              ? html`<div class="empty"><strong>Your cart is empty</strong>Add products from the catalogue.</div>`
              : entries.map(({ productId, quantity }) => {
                  const p = state.byId[productId];
                  return html`<div class="line">
                    <div class="grow"><div class="product-name">${p.name}</div>
                      <div class="muted small">${formatINR(p.price)} / ${p.unit}${isUnavailable(p) ? ' · out of stock' : ''}</div></div>
                    <div class="right">
                      <input class="input small num" style="width:72px" type="number" min="0" step="any" value="${quantity}" data-qty="${productId}" aria-label="Quantity for ${p.name}">
                      <div class="money small">${formatINR(p.price * quantity)}</div>
                      <button class="btn ghost small" data-remove="${productId}">Remove</button>
                    </div></div>`;
                })}
            ${entries.length ? html`
              <h3 style="margin:var(--space-5) 0 var(--space-3)">Delivery</h3>
              <div class="form-grid">
                <label class="field"><span class="label">Slot</span>
                  <select class="select" id="slot">${Object.entries(DELIVERY_SLOTS).map(([k, v]) =>
                    html`<option value="${k}" ${k === checkout.slot ? 'selected' : ''}>${v.label} · ${v.time}</option>`)}</select></label>
                <label class="field"><span class="label">Date</span>
                  <input class="input" type="date" id="date" value="${checkout.date}" min="${isoDate(1)}" max="${isoDate(7)}" ${checkout.slot === 'express' ? 'disabled' : ''}>
                  ${checkout.slot === 'express' ? html`<span class="hint">Express delivers today</span>` : ''}</label>
              </div>
              <h3 style="margin:var(--space-5) 0 var(--space-3)">Payment</h3>
              ${Object.entries(PAYMENT_METHODS).map(([k, v]) => html`
                <label class="check" style="margin-bottom:var(--space-2);align-items:flex-start">
                  <input type="radio" name="pay" value="${k}" ${k === checkout.payment ? 'checked' : ''}>
                  <span><strong>${v.label}</strong><br><span class="muted small">${v.hint}</span></span></label>`)}
              <label class="field" style="margin-top:var(--space-4)"><span class="label">Order notes (optional)</span>
              <textarea class="textarea" id="notes" rows="2" maxlength="500" placeholder="Gate code, packing instructions…">${checkout.notes}</textarea></label>` : ''}
          </div>
          <div class="drawer-foot">
            <div class="spread small muted"><span>Subtotal</span><span class="num">${formatINR(total)}</span></div>
            <div class="spread small muted" style="margin-bottom:var(--space-2)"><span>GST</span><span class="num">${formatINR(tax)}</span></div>
            <div class="spread" style="margin-bottom:var(--space-3)"><strong>Total</strong><span class="money" style="font-size:var(--text-lg)">${formatINR(total + tax)}</span></div>
            <button class="btn primary block large" id="place" ${entries.length && canOrder() ? '' : 'disabled'}>Place order</button>
            ${canOrder() ? '' : html`<p class="muted small center" style="margin-top:var(--space-2)">Ordering unlocks after approval.</p>`}
          </div>
        </aside>`);
    }

    on(overlay, 'change', '[data-qty]', (_e, el) => {
      const p = state.byId[el.dataset.qty];
      const v = Number(el.value);
      setQty(p.id, v > 0 ? Math.max(v, p.min_order_qty) : 0);
    });
    on(overlay, 'click', '[data-remove]', (_e, el) => setQty(el.dataset.remove, 0));
    on(overlay, 'change', '#slot', (_e, el) => { checkout.slot = el.value; draw(); });
    on(overlay, 'change', '#date', (_e, el) => { checkout.date = el.value; });
    on(overlay, 'change', '[name="pay"]', (_e, el) => { checkout.payment = el.value; });
    on(overlay, 'input', '#notes', (_e, el) => { checkout.notes = el.value; });
    on(overlay, 'click', '#place', async (_e, button) => {
      try {
        const order = await withBusy(button, () => placeOrder(toOrderItems(), {
          notes: checkout.notes, deliveryDate: checkout.date, slot: checkout.slot, paymentMethod: checkout.payment,
        }));
        clearCart();
        close();
        toast(`Order ${order.order_number} placed — ${formatINR(order.total_amount)}`, 'success');
        location.hash = '#orders';
      } catch (error) { reportError(error); }
    });
    draw();
  }
  on(document.body, 'click', '#open-cart', openCart);

  // ----- Routes ------------------------------------------------------------
  await loadCatalogue().catch(reportError);

  startRouter({
    container: view,
    fallback: '#catalogue',
    onRoute: (key) => shell.setActive(key),
    routes: {
      '#catalogue': withBanner((c) => renderCatalogue(c, state)),
      '#orders': withBanner((c) => renderOrders(c, state)),
      '#account': withBanner((c) => renderAccount(c, state)),
    },
  });
}
