// =============================================================================
// main.js — restaurant app entry: auth guard, header, routes, cart drawer.
// Routes: #catalogue (default) · #product/<id> · #orders · #account
// =============================================================================

import { html, mount, $, on, formatINR, reportError, toast, withBusy } from '../../core/ui.js';
import { requireRole } from '../../core/auth.js';
import { renderShell, startRouter } from '../../core/shell.js';
import { listProducts, listCategories, placeOrder, getMyOrderTerms, getCompanySettings, getMyPriceList } from '../../core/api.js';
import { applyPriceList } from '../../core/catalogue.js';
import { renderProduct } from './product.js';
import { renderCatalogue } from './catalogue.js';
import { renderOrders } from './orders.js';
import { renderAccount } from './account.js';
import { cartEntries, cartCount, cartTotal, setQty, clearCart, toOrderItems, onCartChange, orderPreview } from './cart.js';
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
  // terms: MOV, delivery fee, PO rule and whether we deliver (my_order_terms).
  // settings: company_settings (show_prices_incl_gst decides how the catalogue shows prices).
  const state = { me, products: [], categories: [], byId: {}, terms: null, settings: null };
  const canOrder = () => state.me.restaurant?.status === 'approved' && state.terms?.delivers !== false;

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
    let myPrices;
    [state.products, state.categories, state.terms, state.settings, myPrices] = await Promise.all([
      listProducts(), listCategories(), getMyOrderTerms().catch(() => null), getCompanySettings().catch(() => null),
      getMyPriceList().catch(() => [])]);
    // The customer's price list (city / sector) replaces the published price; the cart and
    // place_order then agree, because place_order charges customer_price() too.
    state.products = applyPriceList(state.products, myPrices);
    state.byId = Object.fromEntries(state.products.map((p) => [p.id, p]));
  }

  /** Status banner shown above every page until the restaurant is approved and served. */
  function statusBanner() {
    const status = state.me.restaurant?.status;
    if (status === 'suspended') return html`<div class="banner warn">Your account is suspended. Please contact us to place orders.</div>`;
    if (status !== 'approved') return html`<div class="banner warn">Your account is awaiting approval. You can browse the catalogue now and order as soon as we approve you.</div>`;
    if (state.terms && !state.terms.delivers) return html`<div class="banner warn">We do not deliver to your pin code yet. Update it under <a href="#account">Account</a> or contact us.</div>`;
    return '';
  }

  function withBanner(render) {
    return async (container, param) => {
      const holder = document.createElement('div');
      container.replaceChildren(holder);
      mount(holder, statusBanner());
      const body = document.createElement('div');
      container.append(body);
      await render(body, param);
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
    const checkout = { slot: 'morning', date: isoDate(1), payment: 'cod', notes: '', poReference: '' };
    const needsPo = Boolean(state.terms?.needs_po_reference);

    function draw() {
      const entries = cartEntries().filter((e) => state.byId[e.productId]);
      const preview = orderPreview(state.byId, state.terms);
      const { subtotal: total, tax, deliveryFee, shortfall } = preview;
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
              ${needsPo ? html`<label class="field" style="margin-top:var(--space-4)"><span class="label">Purchase order / indent number</span>
                <input class="input" id="po" maxlength="60" value="${checkout.poReference}" placeholder="PO/2026/0042" required>
                <span class="hint">Required for ${state.terms.sector_name}; printed on the invoice.</span></label>` : ''}
              <label class="field" style="margin-top:var(--space-4)"><span class="label">Order notes (optional)</span>
              <textarea class="textarea" id="notes" rows="2" maxlength="500" placeholder="Gate code, packing instructions…">${checkout.notes}</textarea></label>` : ''}
          </div>
          <div class="drawer-foot">
            ${shortfall > 0 ? html`<div class="banner ${deliveryFee > 0 ? 'info' : 'warn'}" style="margin-bottom:var(--space-3)">
              ${deliveryFee > 0
                ? html`Add ${formatINR(shortfall)} more to reach the ${formatINR(state.terms.min_order_value)} minimum and skip the ${formatINR(deliveryFee)} delivery fee.`
                : html`Minimum order is ${formatINR(state.terms.min_order_value)}. Add ${formatINR(shortfall)} more to place this order.`}</div>` : ''}
            <div class="spread small muted"><span>Subtotal</span><span class="num">${formatINR(total)}</span></div>
            <div class="spread small muted"><span>GST</span><span class="num">${formatINR(tax)}</span></div>
            ${deliveryFee > 0 ? html`<div class="spread small muted"><span>Delivery fee</span><span class="num">${formatINR(deliveryFee)}</span></div>` : ''}
            <div class="spread" style="margin:var(--space-2) 0 var(--space-3)"><strong>Total</strong><span class="money" style="font-size:var(--text-lg)">${formatINR(preview.total)}</span></div>
            <button class="btn primary block large" id="place" ${entries.length && canOrder() && preview.canPlace ? '' : 'disabled'}>Place order</button>
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
    on(overlay, 'input', '#po', (_e, el) => { checkout.poReference = el.value; });
    on(overlay, 'click', '#place', async (_e, button) => {
      if (needsPo && !checkout.poReference.trim()) { toast('Enter your purchase order / indent number first.', 'error'); return; }
      try {
        const order = await withBusy(button, () => placeOrder(toOrderItems(), {
          notes: checkout.notes, deliveryDate: checkout.date, slot: checkout.slot, paymentMethod: checkout.payment,
          poReference: checkout.poReference,
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
    onRoute: (key) => shell.setActive(key === '#product/' ? '#catalogue' : key),
    routes: {
      '#catalogue': withBanner((c) => renderCatalogue(c, state)),
      '#product/': withBanner((c, id) => renderProduct(c, state, id)),
      '#orders': withBanner((c) => renderOrders(c, state)),
      '#account': withBanner((c) => renderAccount(c, state)),
    },
  });
}
