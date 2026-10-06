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

/** Test helper: reload state from storage. */
export function _reset() { lines = load(); }
