// =============================================================================
// main.js — restaurant app entry: auth guard, header, routes, cart drawer.
// Routes: #catalogue (default) · #product/<id> · #orders · #approvals · #plus (standing orders · quotes · spend) · #payments · #help · #account
// The cart obeys the credit rules from my_order_terms (migration 015): pay later
// is offered only while nothing is overdue and the limit has room; and a sector
// switched off under Settings → Launch (migration 014) cannot order.
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
import { renderPayments } from './payments.js';
import { renderHelp } from './help.js';
import { renderApprovals } from './approvals.js';
import { renderOrderingPlus, standingOrderDialog } from './ordering-plus.js';
import { validateCoupon } from '../../core/api.js';
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
  const canOrder = () => state.me.restaurant?.status === 'approved' && state.terms?.delivers !== false && state.terms?.sector_active !== false;

  const shell = renderShell({
    me,
    subtitle: me.restaurant?.name ?? 'Restaurant',
    links: [
      { href: '#catalogue', label: 'Catalogue' },
      { href: '#orders', label: 'My orders' },
      { href: '#approvals', label: 'Approvals' },
      { href: '#plus', label: 'Standing & quotes' },
      { href: '#payments', label: 'Payments' },
      { href: '#help', label: 'Help' },
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
    // Approvals (migration 020): the tab shows only for accounts that hold orders, with a count for approvers.
    const nav = document.querySelector('[data-href="#approvals"]');
    if (nav) nav.hidden = !(state.terms?.needs_order_approval);
    shell.setBadge('#approvals', state.terms?.can_approve ? Number(state.terms?.pending_approvals ?? 0) : 0);
  }

  /** Status banner shown above every page until the restaurant is approved and served. */
  function statusBanner() {
    const status = state.me.restaurant?.status;
    if (status === 'suspended') return html`<div class="banner warn">Your account is suspended. Please contact us to place orders.</div>`;
    if (status !== 'approved') return html`<div class="banner warn">Your account is awaiting approval. You can browse the catalogue now and order as soon as we approve you.${state.me.restaurant?.fssai_doc_path ? '' : html` Uploading your FSSAI licence under <a href="#account">Account → Documents</a> speeds this up.`}</div>`;
    if (state.terms && state.terms.sector_active === false) return html`<div class="banner warn">We are not taking orders from ${state.terms.sector_name ?? 'your sector'} yet. You can browse the catalogue; we will let you know when ordering opens.</div>`;
    if (state.terms && !state.terms.delivers) return html`<div class="banner warn">We do not deliver to your pin code yet. Update it under <a href="#account">Account</a> or contact us.</div>`;
    if (state.terms && Number(state.terms.overdue) > 0) return html`<div class="banner warn">You have overdue invoices of ${formatINR(state.terms.overdue)}. See <a href="#payments">Payments</a> to settle them.</div>`;
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
    const outlets = (state.terms?.outlets ?? []).filter((o) => o.is_active);
    const primary = outlets.find((o) => o.is_primary) ?? outlets[0];
    const checkout = { slot: primary?.default_slot ?? 'morning', date: isoDate(1), payment: 'cod', notes: '', poReference: '', outletId: primary?.id ?? null,
                       couponCode: '', coupon: null };   // coupon: the validate_coupon answer for the current subtotal (migration 021)
    const needsPo = Boolean(state.terms?.needs_po_reference);
    // Pay later is blocked while an invoice is overdue or the limit is used up (place_order enforces it too).
    const creditBlocked = state.terms?.credit_blocked_reason ?? null;

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
              ${outlets.length > 1 ? html`<label class="field" style="margin-bottom:var(--space-3)"><span class="label">Deliver to</span>
                <select class="select" id="outlet">${outlets.map((o) => html`<option value="${o.id}" ${o.id === checkout.outletId ? 'selected' : ''} ${o.delivers ? '' : 'disabled'}>${o.name} — ${o.address}${o.delivers ? '' : ' (not served yet)'}</option>`)}</select></label>` : ''}
              ${state.terms?.orders_held_for_me ? html`<div class="banner info" style="margin-bottom:var(--space-3)">Your orders go to the account owner / approver for sign-off before the kitchen picks them.</div>` : ''}
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
                <label class="check" style="margin-bottom:var(--space-2);align-items:flex-start${k === 'credit' && creditBlocked ? ';opacity:.6' : ''}">
                  <input type="radio" name="pay" value="${k}" ${k === checkout.payment ? 'checked' : ''} ${k === 'credit' && creditBlocked ? 'disabled' : ''}>
                  <span><strong>${v.label}</strong><br><span class="muted small">${k === 'credit' && creditBlocked ? creditBlocked
                    : k === 'credit' && state.terms?.credit_limit != null ? `${v.hint} · ${formatINR(state.terms.credit_available)} of your ${formatINR(state.terms.credit_limit)} limit available`
                    : v.hint}</span></span></label>`)}
              ${needsPo ? html`<label class="field" style="margin-top:var(--space-4)"><span class="label">Purchase order / indent number</span>
                <input class="input" id="po" maxlength="60" value="${checkout.poReference}" placeholder="PO/2026/0042" required>
                <span class="hint">Required for ${state.terms.sector_name}; printed on the invoice.</span></label>` : ''}
              <label class="field" style="margin-top:var(--space-4)"><span class="label">Order notes (optional)</span>
              <textarea class="textarea" id="notes" rows="2" maxlength="500" placeholder="Gate code, packing instructions…">${checkout.notes}</textarea></label>
              <div class="field" style="margin-top:var(--space-4)"><span class="label">Coupon code</span>
                <div class="row" style="gap:var(--space-2)"><input class="input" id="coupon" maxlength="20" value="${checkout.couponCode}" placeholder="WELCOME10" style="text-transform:uppercase;max-width:200px"><button class="btn" type="button" id="apply-coupon">Apply</button></div>
                <span class="hint" id="coupon-hint">${checkout.coupon ? (checkout.coupon.valid ? `${checkout.coupon.label}: −${formatINR(checkout.coupon.discount)}` : checkout.coupon.reason) : ''}</span></div>
              <button class="btn ghost small" type="button" id="save-standing" style="margin-top:var(--space-3)">Save this basket as a standing order</button>` : ''}
          </div>
          <div class="drawer-foot">
            ${shortfall > 0 ? html`<div class="banner ${deliveryFee > 0 ? 'info' : 'warn'}" style="margin-bottom:var(--space-3)">
              ${deliveryFee > 0
                ? html`Add ${formatINR(shortfall)} more to reach the ${formatINR(state.terms.min_order_value)} minimum and skip the ${formatINR(deliveryFee)} delivery fee.`
                : html`Minimum order is ${formatINR(state.terms.min_order_value)}. Add ${formatINR(shortfall)} more to place this order.`}</div>` : ''}
            <div class="spread small muted"><span>Subtotal</span><span class="num">${formatINR(total)}</span></div>
            <div class="spread small muted"><span>GST</span><span class="num">${formatINR(tax)}</span></div>
            ${deliveryFee > 0 ? html`<div class="spread small muted"><span>Delivery fee</span><span class="num">${formatINR(deliveryFee)}</span></div>` : ''}
            ${checkout.coupon?.valid ? html`<div class="spread small" style="color:var(--brand)"><span>Coupon ${checkout.coupon.code}</span><span class="num">−${formatINR(Math.min(checkout.coupon.discount, total))}</span></div>` : ''}
            <div class="spread" style="margin:var(--space-2) 0 var(--space-3)"><strong>Total</strong><span class="money" style="font-size:var(--text-lg)">${formatINR(preview.total - (checkout.coupon?.valid ? Math.min(checkout.coupon.discount, total) : 0))}</span></div>
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
    on(overlay, 'change', '#outlet', (_e, el) => { checkout.outletId = el.value; const o = outlets.find((x) => x.id === el.value); if (o?.default_slot && o.default_slot !== 'express') { checkout.slot = o.default_slot; } draw(); });
    on(overlay, 'change', '#date', (_e, el) => { checkout.date = el.value; });
    on(overlay, 'change', '[name="pay"]', (_e, el) => { checkout.payment = el.value; });
    on(overlay, 'input', '#notes', (_e, el) => { checkout.notes = el.value; });
    on(overlay, 'input', '#po', (_e, el) => { checkout.poReference = el.value; });
    on(overlay, 'input', '#coupon', (_e, el) => { checkout.couponCode = el.value.toUpperCase(); });
    on(overlay, 'click', '#apply-coupon', async (_e, button) => {
      const code = checkout.couponCode.trim();
      if (!code) { checkout.coupon = null; draw(); return; }
      try { checkout.coupon = await withBusy(button, () => validateCoupon(code, orderPreview(state.byId, state.terms).subtotal)); draw(); }
      catch (error) { reportError(error); }
    });
    on(overlay, 'click', '#save-standing', () => standingOrderDialog(state, null, () => { close(); location.hash = '#plus'; }));
    on(overlay, 'click', '#place', async (_e, button) => {
      if (needsPo && !checkout.poReference.trim()) { toast('Enter your purchase order / indent number first.', 'error'); return; }
      try {
        const order = await withBusy(button, () => placeOrder(toOrderItems(), {
          notes: checkout.notes, deliveryDate: checkout.date, slot: checkout.slot, paymentMethod: checkout.payment,
          poReference: checkout.poReference, outletId: outlets.length > 1 ? checkout.outletId : null,
          couponCode: checkout.coupon?.valid ? checkout.coupon.code : null,
        }));
        clearCart();
        close();
        toast(order.approval_status === 'pending'
          ? `Order ${order.order_number} sent for approval — ${formatINR(order.total_amount)}`
          : `Order ${order.order_number} placed — ${formatINR(order.total_amount)}`, 'success');
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
      '#payments': withBanner((c) => renderPayments(c, state)),
      '#approvals': withBanner((c) => renderApprovals(c, state, (n) => shell.setBadge('#approvals', n))),
      '#plus': withBanner((c) => renderOrderingPlus(c, state)),
      '#help': withBanner((c) => renderHelp(c, state)),
      '#account': withBanner((c) => renderAccount(c, state)),
    },
  });
}
