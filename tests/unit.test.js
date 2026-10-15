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

// ---------- Migration 006 helpers: CSV, permissions, order preview, audit ----

// audit.js imports api.js, which needs a Supabase client to exist; a blank fake will do.
const { createFake, useFake } = await import('./helpers/fake-supabase.js');
useFake(createFake());
const { toCsv } = await import('../web/js/core/csv.js');
const { can, visibleNav, toPermissionSet } = await import('../web/js/core/permissions.js');
const { describeChanges } = await import('../web/js/pages/admin/audit.js');

test('toCsv: header row, quoting of commas, quotes and newlines, value functions', () => {
  const csv = toCsv([{ name: 'Spice, Hut', note: 'He said "hi"\nbye', total: 10 }], [
    { key: 'name', label: 'Customer' }, { key: 'note', label: 'Note' }, { label: 'Total', value: (r) => r.total * 2 },
  ]);
  assert.equal(csv, 'Customer,Note,Total\r\n"Spice, Hut","He said ""hi""\nbye",20');
});

test('toCsv: null and undefined become empty cells', () => {
  assert.equal(toCsv([{ a: null }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]), 'A,B\r\n,');
});

test('can: super admin may do everything, others only what the matrix allows, customers nothing', () => {
  const superAdmin = { profile: { role: 'admin', team_role: 'super_admin' }, permissions: new Set() };
  const picker = { profile: { role: 'admin', team_role: 'picker' }, permissions: toPermissionSet([{ module: 'orders', action: 'view' }, { module: 'orders', action: 'edit' }]) };
  const customer = { profile: { role: 'restaurant' }, permissions: new Set() };
  assert.equal(can(superAdmin, 'team', 'edit'), true);
  assert.equal(can(picker, 'orders', 'edit'), true);
  assert.equal(can(picker, 'payments', 'edit'), false);
  assert.equal(can(customer, 'orders', 'view'), false);
  assert.equal(can(null, 'orders', 'view'), false);
  assert.deepEqual(visibleNav(picker), [{ href: '#orders', label: 'Orders' }]);
  assert.equal(visibleNav(superAdmin).length, 8, 'every module with a nav entry');
});

test('orderPreview: below the minimum the delivery fee applies; with no fee the order is blocked', () => {
  cart.clearCart();
  cart.setQty('a', 10);                                   // 10 x 32 = 320
  const products = { a: { price: 32, gst_rate: 5 } };
  const withFee = cart.orderPreview(products, { min_order_value: 2000, delivery_fee_below_mov: 99 });
  assert.equal(withFee.subtotal, 320);
  assert.equal(withFee.tax, 16);
  assert.equal(withFee.shortfall, 1680);
  assert.equal(withFee.deliveryFee, 99);
  assert.equal(withFee.total, 435);
  assert.equal(withFee.canPlace, true);

  const noFee = cart.orderPreview(products, { min_order_value: 2000, delivery_fee_below_mov: 0 });
  assert.equal(noFee.canPlace, false);
  assert.equal(noFee.deliveryFee, 0);

  const above = cart.orderPreview(products, { min_order_value: 300, delivery_fee_below_mov: 99 });
  assert.equal(above.deliveryFee, 0);
  assert.equal(above.total, 336);
  assert.equal(cart.orderPreview(products, null).total, 336, 'no terms = no rules');
  cart.clearCart();
});

test('describeChanges: updates list each changed column with old and new', () => {
  const lines = describeChanges({ action: 'update', changes: { price: { old: 32, new: 33 }, brand: { old: null, new: 'Farm' } } });
  assert.deepEqual(lines, [{ key: 'price', old: '32', new: '33' }, { key: 'brand', old: '—', new: 'Farm' }]);
  assert.deepEqual(describeChanges({ action: 'insert', changes: {} }), [{ key: 'created', old: null, new: null }]);
});
