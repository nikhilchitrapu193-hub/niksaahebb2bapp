// Unit tests for pure helpers: escaping, formatting, cart arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom.js';

installDom();
const { html, escapeHtml, raw, formatINR, formatQty, statusBadge } = await import('../web/js/core/ui.js');
const cart = await import('../web/js/pages/restaurant/cart.js');

test('html`` escapes interpolated values', () => {
  const evil = '<img src=x onerror="alert(1)">';
  assert.equal(html`<p>${evil}</p>`.toString(),
    '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
});

test('html`` leaves nested html`` and raw() untouched, drops null/false', () => {
  const inner = html`<b>${'a&b'}</b>`;
  assert.equal(html`${inner}${raw('<i>x</i>')}${null}${false}${undefined}`.toString(), '<b>a&amp;b</b><i>x</i>');
});

test('html`` renders arrays and escapes each item', () => {
  assert.equal(html`<ul>${['<a>', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`.toString(),
    '<ul><li>&lt;a&gt;</li><li>b</li></ul>');
});

test('escapeHtml handles quotes and numbers', () => {
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
  assert.equal(escapeHtml(5), '5');
});

test('formatINR uses rupees and Indian digit grouping', () => {
  assert.equal(formatINR(1234567.5).replace(/\s/g, ''), '₹12,34,567.50');
  assert.equal(formatINR('abc').replace(/\s/g, ''), '₹0.00');
});

test('formatQty drops trailing zeros', () => assert.equal(formatQty('2.50'), '2.5'));

test('statusBadge uses a readable label', () => {
  assert.match(statusBadge('out_for_delivery').toString(), /Out for delivery/);
});

test('cart: set, merge, remove and total', () => {
  cart.clearCart();
  cart.setQty('a', 2);
  cart.setQty('b', 1.5);
  assert.equal(cart.cartCount(), 2);
  assert.equal(cart.cartTotal({ a: { price: 10 }, b: { price: 100 } }), 170);
  cart.setQty('a', 0);
  assert.equal(cart.getQty('a'), 0);
  assert.deepEqual(cart.toOrderItems(), [{ product_id: 'b', quantity: 1.5 }]);
});

test('cart: ignores unknown products in the total and persists to storage', () => {
  cart.clearCart();
  cart.setQty('ghost', 3);
  assert.equal(cart.cartTotal({}), 0);
  assert.ok(localStorage.getItem('fresh-supply-cart-v1').includes('ghost'));
});
