// Smoke tests: import each real page module against a fake Supabase client and
// check what it renders and which backend calls it makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor, importFresh } from './helpers/dom.js';
import { createFake, useFake } from './helpers/fake-supabase.js';

const ADMIN = { id: 'u-admin', role: 'admin', full_name: 'Asha Admin', is_active: true };
const RESTAURANT_USER = { id: 'u-r', role: 'restaurant', full_name: 'Ravi', is_active: true };
const DRIVER = { id: 'u-d', role: 'delivery', full_name: 'Dev Driver', is_active: true };

const PRODUCTS = [
  { id: 'p1', sku: 'VEG-001', name: 'Tomato', price: 32, market_price: 40, gst_rate: 0, unit: 'kg', min_order_qty: 5, in_stock: true, is_active: true, stock_qty: 200, low_stock_threshold: 20, category_id: 'c1', categories: { name: 'Vegetables' } },
  { id: 'p2', sku: 'X-1', name: '<img src=x onerror=alert(1)>', price: 10, gst_rate: 5, unit: 'kg', min_order_qty: 1, in_stock: false, is_active: true, stock_qty: 0, low_stock_threshold: 0, category_id: 'c1', categories: { name: 'Vegetables' } },
  { id: 'p3', sku: 'DAI-002', name: 'Paneer', price: 340, gst_rate: 5, unit: 'kg', min_order_qty: 2, in_stock: true, is_active: true, stock_qty: 5, low_stock_threshold: 10, category_id: 'c1', categories: { name: 'Vegetables' } },
];
const ORDER = {
  id: 'o1', order_number: 'ORD-1001', status: 'placed', restaurant_name: 'Spice Hut', delivery_address: '12 MG Road',
  contact_phone: '999', total_amount: 160, created_at: '2026-10-05T05:00:00Z', assigned_to: null,
  subtotal: 160, tax_amount: 0, delivery_date: '2026-10-06', delivery_slot: 'morning', payment_method: 'credit', payment_status: 'unpaid',
  order_items: [{ product_id: 'p1', product_name: 'Tomato', unit: 'kg', unit_price: 32, quantity: 5, line_total: 160, gst_rate: 0, tax_amount: 0 }],
};
const COMPANY = { id: true, name: 'Fresh Supply Pvt Ltd', address: 'Hyderabad', phone: '040', email: 'x@y.z', gstin: '36ABC', fssai: '123', invoice_note: 'Thanks' };

/** Install DOM + fake backend for one test. */
function setup({ session, profile, tables = {}, rpc = {}, body }) {
  const env = installDom(body);
  const fake = createFake({
    session,
    tables: { profiles: profile ? [profile] : [], categories: [{ id: 'c1', name: 'Vegetables', sort_order: 10 }], ...tables },
    rpc,
  });
  useFake(fake);
  return { ...env, fake };
}

test('login: wrong password shows a friendly error', async () => {
  const { document } = setup({});
  await importFresh('web/js/pages/login.js');
  await waitFor(() => document.querySelector('#form'));
  document.querySelector('[name=email]').value = 'bad@example.com';
  document.querySelector('[name=password]').value = 'whatever';
  document.querySelector('#form').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('#error').textContent);
  assert.equal(document.querySelector('#error').textContent, 'Incorrect email or password.');
});

test('login: signed-in admin on the admin login page is sent to /admin/', async () => {
  const { location } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    body: '<div id="auth-root" data-role="admin"></div>',
  });
  await importFresh('web/js/pages/login.js');
  await waitFor(() => location.replaced);
  assert.match(location.replaced, /admin\/$/);
});

test('login: a restaurant account signing in on the admin page is rejected', async () => {
  const { document, fake } = setup({
    profile: RESTAURANT_USER,
    body: '<div id="auth-root" data-role="admin"></div>',
    tables: { restaurants: [{ id: 'r1', owner_id: 'u-r@x.com', name: 'Spice Hut', status: 'approved' }] },
    rpc: { claim_first_admin: () => false },
  });
  fake.tables.profiles = [{ ...RESTAURANT_USER, id: 'u-r@x.com' }]; // id the fake assigns on sign-in
  await importFresh('web/js/pages/login.js');
  await waitFor(() => document.querySelector('#form'));
  assert.equal(document.querySelector('[data-mode="register"]'), null, 'admin page has no register tab');
  document.querySelector('[name=email]').value = 'r@x.com';
  document.querySelector('[name=password]').value = 'secret123';
  document.querySelector('#form').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('#error').textContent);
  assert.match(document.querySelector('#error').textContent, /restaurant partner account/i);
  assert.equal(fake.state.session, null, 'signed out again');
});

test('login: first-time setup on the admin page creates the account and claims admin', async () => {
  const { document, location, fake } = setup({ body: '<div id="auth-root" data-role="admin"></div>', rpc: { claim_first_admin: () => true } });
  await importFresh('web/js/pages/login.js');
  await waitFor(() => document.querySelector('[data-mode="setup"]')).then((a) => a.click());
  const form = await waitFor(() => document.querySelector('[name=fullName]') && document.querySelector('#form'));
  form.querySelector('[name=fullName]').value = 'Asha';
  form.querySelector('[name=email]').value = 'asha@x.com';
  form.querySelector('[name=password]').value = 'secret123';
  // The fake signUp issues no session (email confirmation on) → tells the user to confirm then sign in.
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('.banner.info'));
  assert.match(document.querySelector('.banner.info').textContent, /first sign-in becomes the admin/);

  // Now sign in as that (still-restaurant-role, no restaurant row) user: claim succeeds → admin home.
  fake.tables.profiles = [{ id: 'u-asha@x.com', role: 'restaurant', is_active: true, full_name: 'Asha' }];
  document.querySelector('[data-mode="signin"]').click();
  await waitFor(() => document.querySelector('[name=password]'));
  document.querySelector('[name=email]').value = 'asha@x.com';
  document.querySelector('[name=password]').value = 'secret123';
  document.querySelector('#form').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'claim_first_admin'));
  await waitFor(() => location.href);
  assert.match(location.href, /admin\/$/);
});

test('guard: unauthenticated visitor to the delivery app goes to the delivery login', async () => {
  const { location } = setup({});
  await importFresh('web/js/pages/delivery/main.js');
  assert.match(location.replaced, /delivery\/login\.html$/);
});

test('guard: a restaurant opening the admin app is bounced to its own home', async () => {
  const { location } = setup({ session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER });
  await importFresh('web/js/pages/admin/main.js');
  assert.match(location.replaced, /restaurant\/$/);
});

test('guard: no session sends the visitor to the login page', async () => {
  const { location } = setup({});
  await importFresh('web/js/pages/admin/main.js');
  assert.ok(location.replaced);
});

test('restaurant: catalogue renders products, escapes names, blocks ordering until approved', async () => {
  const { document } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } },
    profile: RESTAURANT_USER,
    tables: { restaurants: [{ id: 'r1', owner_id: 'u-r', name: 'Spice Hut', status: 'pending' }], products: PRODUCTS },
  });
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('.product-card'));

  assert.equal(document.querySelectorAll('.product-card').length, 3);
  assert.match(document.body.textContent, /Only 5 kg left/, 'low-stock hint');
  assert.match(document.body.textContent, /save 20%/, 'market price comparison');
  assert.equal(document.querySelector('img[onerror]'), null, 'product name must not become markup');
  assert.match(document.querySelector('.banner.warn').textContent, /awaiting approval/);
  assert.match(document.body.textContent, /Out of stock/);
  assert.match(document.body.textContent.replace(/\s/g, ''), /₹32\.00/);
});

test('restaurant: approved restaurant can add to cart and place an order', async () => {
  const { document, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } },
    profile: RESTAURANT_USER,
    tables: { restaurants: [{ id: 'r1', owner_id: 'u-r', name: 'Spice Hut', status: 'approved' }], products: PRODUCTS, orders: [] },
    rpc: { place_order: () => ({ id: 'o9', order_number: 'ORD-1009', total_amount: 160 }) },
  });
  localStorage.clear();
  const cart = await import('../web/js/pages/restaurant/cart.js');
  cart._reset();
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-add="p1"]'));

  document.querySelector('[data-add="p1"]').click();          // adds the minimum quantity (5)
  assert.equal(cart.getQty('p1'), 5);

  document.querySelector('#open-cart').click();
  const place = await waitFor(() => document.querySelector('#place:not([disabled])'));
  place.click();
  await waitFor(() => fake.calls.some((c) => c.name === 'place_order'));

  const call = fake.calls.find((c) => c.name === 'place_order');
  assert.deepEqual(call.args.p_items, [{ product_id: 'p1', quantity: 5 }]);
  assert.equal(call.args.p_delivery_slot, 'morning');
  assert.equal(call.args.p_payment_method, 'cod');
  assert.match(call.args.p_delivery_date, /^\d{4}-\d{2}-\d{2}$/);
  await waitFor(() => cart.cartCount() === 0);
});

test('admin: dashboard shows stats from the stats function', async () => {
  const { document } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    rpc: {
      admin_dashboard_stats: () => ({ orders_today: 7, revenue_today: 12500, revenue_7d: 80000, pending_restaurants: 2,
        open_orders_by_status: { placed: 3 }, top_products_30d: [{ name: 'Tomato', quantity: 50, revenue: 1600 }] }),
    },
  });
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.stat-grid'));
  const text = document.body.textContent.replace(/\s/g, '');
  assert.match(text, /₹12,500\.00/);
  assert.match(text, /Tomato/);
  assert.match(document.body.textContent, /2 restaurants waiting for approval/);
});

test('admin: orders list opens detail and advances status via set_order_status', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    tables: { orders: [ORDER], order_status_history: [{ order_id: 'o1', to_status: 'placed', created_at: ORDER.created_at }] },
    rpc: { admin_dashboard_stats: () => ({ pending_restaurants: 0 }), admin_list_users: () => [], set_order_status: () => null },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/admin/main.js');
  const row = await waitFor(() => document.querySelector('[data-order="o1"]'));
  row.click();
  const next = await waitFor(() => document.querySelector('[data-next]'));
  assert.match(next.textContent, /Confirm order/);
  next.click();
  await waitFor(() => fake.calls.some((c) => c.name === 'set_order_status'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'set_order_status').args,
    { p_order_id: 'o1', p_new: 'confirmed', p_note: null });
});

test('delivery: shows only active assignments with map and call links', async () => {
  const { document } = setup({
    session: { user: { id: 'u-d', email: 'd@x.com' } },
    profile: DRIVER,
    tables: { orders: [{ ...ORDER, status: 'packed', assigned_to: 'u-d' }] },
  });
  await importFresh('web/js/pages/delivery/main.js');
  await waitFor(() => document.querySelector('[data-start]'));
  assert.match(document.querySelector('a[href^="https://www.google.com/maps"]').href, /12%20MG%20Road/);
  assert.equal(document.querySelector('a[href="tel:999"]') !== null, true);
});

test('admin: orders detail can mark a credit order paid', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    tables: { orders: [ORDER], order_status_history: [] },
    rpc: { admin_dashboard_stats: () => ({ pending_restaurants: 0 }), admin_list_users: () => [], set_order_payment: () => null },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/admin/main.js');
  (await waitFor(() => document.querySelector('[data-order="o1"]'))).click();
  (await waitFor(() => document.querySelector('[data-pay="paid"]'))).click();
  await waitFor(() => fake.calls.some((c) => c.name === 'set_order_payment'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'set_order_payment').args, { p_order_id: 'o1', p_status: 'paid' });
});

test('admin: inventory lists stock levels and receives stock via receive_stock', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    tables: { products: PRODUCTS, suppliers: [{ id: 's1', name: 'Farm Co', is_active: true }] },
    rpc: { admin_dashboard_stats: () => ({ pending_restaurants: 0 }), receive_stock: () => null },
  });
  location.hash = '#inventory';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#receive'));
  assert.match(document.querySelector('.banner.warn').textContent, /2 products at or below/);
  assert.equal(document.querySelectorAll('.badge.low, .badge.empty-stock').length, 2);

  document.querySelector('#receive').click();
  const form = await waitFor(() => document.querySelector('#grn'));
  const select = form.querySelector('[data-field="product_id"]');
  select.value = 'p3'; select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  const qty = form.querySelector('[data-field="quantity"]');
  qty.value = '25'; qty.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  form.querySelector('[name=supplier]').value = 's1';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'receive_stock'));
  const call = fake.calls.find((c) => c.name === 'receive_stock');
  assert.deepEqual(call.args.p_items, [{ product_id: 'p3', quantity: 25, unit_cost: null }]);
  assert.equal(call.args.p_supplier_id, 's1');
});

test('admin: team page sends an invite through the invite-staff function', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    rpc: { admin_dashboard_stats: () => ({ pending_restaurants: 0 }), admin_list_users: () => [ADMIN], 'invite-staff': () => ({ ok: true }) },
  });
  location.hash = '#team';
  await importFresh('web/js/pages/admin/main.js');
  const form = await waitFor(() => document.querySelector('#invite-form'));
  form.querySelector('[name=email]').value = 'driver@x.com';
  form.querySelector('[name=role]').value = 'delivery';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'function'));
  const call = fake.calls.find((c) => c.type === 'function');
  assert.equal(call.name, 'invite-staff');
  assert.equal(call.body.email, 'driver@x.com');
  assert.equal(call.body.role, 'delivery');
  assert.match(call.body.redirect_to, /reset\.html\?role=delivery$/);
});

test('admin: settings form saves company details', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    tables: { company_settings: [COMPANY] },
    rpc: { admin_dashboard_stats: () => ({ pending_restaurants: 0 }) },
  });
  location.hash = '#settings';
  await importFresh('web/js/pages/admin/main.js');
  const form = await waitFor(() => document.querySelector('#settings-form'));
  form.querySelector('[name=gstin]').value = '36NEW';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'company_settings'));
  assert.equal(fake.calls.find((c) => c.table === 'company_settings').payload.gstin, '36NEW');
});

test('invoice: renders seller, buyer, lines and totals for an order', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } },
    profile: RESTAURANT_USER,
    tables: { restaurants: [{ id: 'r1', owner_id: 'u-r', name: 'Spice Hut', status: 'approved', gstin: '36BUYER' }], orders: [ORDER], company_settings: [COMPANY] },
    body: '<main id="invoice"></main>',
  });
  location.search = '?order=o1';
  await importFresh('web/js/pages/invoice.js');
  await waitFor(() => document.querySelector('.parties'));
  const text = document.body.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Fresh Supply Pvt Ltd/);
  assert.match(text, /GSTIN 36ABC/);
  assert.match(text, /GSTIN 36BUYER/);
  assert.match(text, /ORD-1001/);
  assert.match(text, /Tomato/);
  assert.match(text.replace(/\s/g, ''), /₹160\.00/);
});

test('landing: public page lists categories and featured products without a session', async () => {
  const { document } = setup({
    tables: { products: PRODUCTS },
    body: '<div id="categories"></div><div id="featured"></div>',
  });
  await importFresh('web/js/pages/landing.js');
  await waitFor(() => document.querySelector('.category-tile'));
  assert.equal(document.querySelectorAll('.category-tile').length, 1);
  assert.equal(document.querySelectorAll('#featured .product-card').length, 2, 'only in-stock products are featured');
  assert.equal(document.querySelector('img[onerror]'), null);
});

test.after(() => setTimeout(() => process.exit(0), 50)); // delivery page leaves a polling timer running
