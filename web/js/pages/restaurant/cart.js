// =============================================================================
// cart.js — the shopping cart. Pure data + localStorage; no DOM here, so it is
// trivial to unit-test. Prices shown in the cart are for display only: the
// database recalculates every price when the order is placed.
// =============================================================================

const STORAGE_KEY = 'fresh-supply-cart-v1';

/** Map of productId -> quantity (number). */
let lines = load();
const listeners = new Set();

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return Object.fromEntries(Object.entries(parsed).filter(([, q]) => Number(q) > 0));
  } catch { return {}; }
}

function commit() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(lines)); } catch { /* private mode: cart lives in memory */ }
  listeners.forEach((fn) => fn());
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function onCartChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function getQty(productId) { return lines[productId] ?? 0; }

/** Set a quantity; zero or less removes the line. */
export function setQty(productId, qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) delete lines[productId];
  else lines[productId] = Math.round(n * 100) / 100;
  commit();
}

export function clearCart() { lines = {}; commit(); }

export function cartEntries() { return Object.entries(lines).map(([productId, quantity]) => ({ productId, quantity })); }

export function cartCount() { return Object.keys(lines).length; }

/** Total price using a { id: product } lookup; unknown products are skipped. */
export function cartTotal(productsById) {
  return cartEntries().reduce((sum, { productId, quantity }) => {
    const product = productsById[productId];
    return product ? sum + product.price * quantity : sum;
  }, 0);
}

/** Convert to the payload place_order() expects. */
export function toOrderItems() {
  return cartEntries().map(({ productId, quantity }) => ({ product_id: productId, quantity }));
}

/**
 * What the order will cost, using the same rule as place_order() in the
 * database (migration 006): below the minimum order value the delivery fee is
 * charged, and if that fee is zero the order cannot be placed.
 *   terms: { min_order_value, delivery_fee_below_mov } (null = no rules)
 * Returns { subtotal, tax, deliveryFee, shortfall, total, canPlace }.
 */
export function orderPreview(productsById, terms) {
  let subtotal = 0;
  let tax = 0;
  for (const { productId, quantity } of cartEntries()) {
    const product = productsById[productId];
    if (!product) continue;
    subtotal += product.price * quantity;
    tax += Math.round(product.price * quantity * (product.gst_rate || 0)) / 100;
  }
  const mov = Number(terms?.min_order_value) || 0;
  const feeBelow = Number(terms?.delivery_fee_below_mov) || 0;
  const shortfall = subtotal < mov ? mov - subtotal : 0;
  const deliveryFee = shortfall > 0 ? feeBelow : 0;
  return {
    subtotal, tax, deliveryFee, shortfall,
    total: subtotal + tax + deliveryFee,
    canPlace: shortfall === 0 || feeBelow > 0,
  };
}

/** Test helper: reload state from storage. */
export function _reset() { lines = load(); }
