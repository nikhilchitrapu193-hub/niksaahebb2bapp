// Smoke tests: import each real page module against a fake Supabase client and
// check what it renders and which backend calls it makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor, importFresh } from './helpers/dom.js';
import { createFake, useFake } from './helpers/fake-supabase.js';

const ADMIN = { id: 'u-admin', role: 'admin', team_role: 'super_admin', full_name: 'Asha Admin', is_active: true };
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

// Migration 006 fixtures: one city with a default warehouse, a picker with a small permission set.
const CITY = { id: 'city-vz', name: 'Visakhapatnam', state_code: '37', is_active: true, sort_order: 10 };
const WAREHOUSE = { id: 'wh-1', city_id: 'city-vz', name: 'Vizag main warehouse', address: '', is_default: true, is_active: true };
const ZONE = { id: 'z1', warehouse_id: 'wh-1', pincode: '530001', area_name: 'GPO', is_active: true };
const SECTORS = [
  { code: 'restaurant', name: 'Restaurants & cloud kitchens', description: '', min_order_value: 2000, delivery_fee_below_mov: 99, credit_days: 7, customer_edit_window_minutes: 15, needs_po_reference: false, needs_order_approval: false, can_self_register: true, is_active: true, sort_order: 10 },
  { code: 'defence', name: 'Army cantonments & unit messes', description: 'Contract rates, PO on every order', min_order_value: 0, delivery_fee_below_mov: 0, credit_days: 60, customer_edit_window_minutes: 0, needs_po_reference: true, needs_order_approval: true, can_self_register: true, is_active: true, sort_order: 40 },
  { code: 'retail', name: 'Small retailers & kiranas', description: 'Smaller packs, pay now', min_order_value: 500, delivery_fee_below_mov: 49, credit_days: 0, customer_edit_window_minutes: 15, needs_po_reference: false, needs_order_approval: false, can_self_register: false, is_active: true, sort_order: 50 },
];
const TEAM_ROLES = [
  { code: 'super_admin', name: 'Super admin', description: '', sort_order: 10 },
  { code: 'picker', name: 'Picker / packer', description: 'Picks and packs', sort_order: 100 },
  { code: 'driver', name: 'Driver', description: '', sort_order: 110 },
];
const PICKER = { id: 'u-pick', role: 'admin', team_role: 'picker', full_name: 'Pavan Picker', is_active: true };
const PICKER_PERMISSIONS = [{ team_role: 'picker', module: 'orders', action: 'view' }, { team_role: 'picker', module: 'orders', action: 'edit' }];
const RESTAURANT = { id: 'r1', owner_id: 'u-r', name: 'Spice Hut', status: 'approved', sector_code: 'restaurant', city_id: 'city-vz', warehouse_id: 'wh-1', pincode: '530001' };
const ADMIN_RPC = { admin_dashboard_stats: () => ({ pending_restaurants: 0 }), admin_list_users: () => [ADMIN] };
// Migration 009 fixtures: HSN codes, one global + one category rule, two benchmark sources, and
// what price_board() returns for tomato (inputs + computed result, as the database builds it).
const HSN = [{ code: '0702', description: 'Tomatoes, fresh', default_gst_rate: 0 }, { code: '0406', description: 'Paneer', default_gst_rate: 5 }];
const RULES = [
  { id: 'rule-g', category_id: null, categories: null, markup_pct: 10, min_markup_pct: 3, wastage_pct: 2, handling_per_kg: 0, packing_per_unit: 0, transport_per_kg: 0, market_fee_pct: 0, other_cost_pct: 0, rounding_step: 1, round_mode: 'nearest', benchmark_cap_pct: null, benchmark_source_id: null, cost_method: 'weighted_avg_30d', guard_mode: 'warn', effective_from: '2026-01-01', effective_to: null, note: 'Global default' },
  { id: 'rule-v', category_id: 'c1', categories: { name: 'Vegetables' }, markup_pct: 15, min_markup_pct: 8, wastage_pct: 8, handling_per_kg: 0, packing_per_unit: 0, transport_per_kg: 0, market_fee_pct: 0, other_cost_pct: 0, rounding_step: 0.5, round_mode: 'nearest', benchmark_cap_pct: 10, benchmark_source_id: 'src-rb', cost_method: 'weighted_avg_30d', guard_mode: 'warn', effective_from: '2026-01-01', effective_to: null, note: null },
];
const SOURCES = [{ id: 'src-rb', code: 'rythu_bazaar', name: 'Rythu Bazaar board', kind: 'manual', url: null, is_active: true, sort_order: 10 }, { id: 'src-necc', code: 'necc', name: 'NECC egg rate', kind: 'manual', url: null, is_active: true, sort_order: 20 }];
const BOARD_TOMATO = {
  product_id: 'p1', sku: 'VEG-001', name: 'Tomato', unit: 'kg', category_id: 'c1', category_name: 'Vegetables', current_price: 32, current_market_price: 40, price_source: 'manual', gst_rate: 0,
  weight_kg: 1, rule_source: 'category', has_override: false, pricing_mode: 'rule', cost_method: 'weighted_avg_30d', markup_pct: 15, min_markup_pct: 8, wastage_pct: 8, yield_pct: 100,
  handling_per_kg: 0, packing_per_unit: 0, transport_per_kg: 0, market_fee_pct: 0, other_cost_pct: 0, rounding_step: 0.5, round_mode: 'nearest', benchmark_cap_pct: 10, guard_mode: 'warn',
  fixed_margin_amount: null, manual_price: null, manual_reason: null, manual_cost: null, supplier_quote: null, quote_date: null,
  latest_cost: 20, latest_cost_date: '2026-10-14', avg_cost_30d: 20, benchmark_price: 22, benchmark_date: '2026-10-15', benchmark_source: 'rythu_bazaar', benchmark_source_name: 'Rythu Bazaar board', benchmark_age_days: 0,
  cost_basis: 20, landed_cost: 21.74, raw_price: 24.2, suggested_price: 24, capped: true, margin_amount: 2.26, margin_pct: 9.42, markup_effective_pct: 10.4, flags: ['capped'],
};
const BOARD_PANEER = { ...BOARD_TOMATO, product_id: 'p3', sku: 'DAI-002', name: 'Paneer', category_name: 'Vegetables', current_price: 340, latest_cost: null, avg_cost_30d: null, benchmark_price: null, benchmark_source: null, benchmark_source_name: null, benchmark_age_days: null, benchmark_date: null,
  cost_basis: null, landed_cost: null, raw_price: null, suggested_price: null, capped: false, margin_amount: null, margin_pct: null, markup_effective_pct: null, flags: ['no_cost'] };
const PRICING_RPC = { ...ADMIN_RPC, publish_due_prices: () => 0, price_board: () => [BOARD_PANEER, BOARD_TOMATO], apply_prices: () => ({ applied: 1, scheduled: 0 }) };

const TERMS = { min_order_value: 2000, delivery_fee_below_mov: 99, credit_days: 7, needs_po_reference: false, sector_name: 'Restaurants & cloud kitchens', delivers: true };

/** Install DOM + fake backend for one test. */
function setup({ session, profile, tables = {}, rpc = {}, body }) {
  const env = installDom(body);
  const fake = createFake({
    session,
    tables: {
      profiles: profile ? [profile] : [], categories: [{ id: 'c1', name: 'Vegetables', sort_order: 10, parent_id: null }, { id: 'c1a', name: 'Leafy greens', sort_order: 11, parent_id: 'c1' }],
      cities: [CITY], warehouses: [WAREHOUSE], service_zones: [ZONE], sectors: SECTORS, team_roles: TEAM_ROLES,
      role_permissions: PICKER_PERMISSIONS, warehouse_stock: [], product_city_availability: [], audit_log: [],
      hsn_codes: HSN, pricing_rules: RULES, product_pricing: [], benchmark_sources: SOURCES, benchmark_prices: [], price_history: [], scheduled_prices: [],
      company_settings: [COMPANY], price_lists: [], price_list_items: [],
      supplier_products: [], purchase_orders: [], goods_receipts: [],
      vehicles: [], trips: [], trip_orders: [], stock_batches: [], delivery_returns: [],
      driver_cash: [], cash_settlements: [], delivery_charge_rules: [], slot_config: [], order_issues: [], credit_notes: [],
      ...tables,
    },
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
  assert.match(document.querySelector('#error').textContent, /customer account/i);
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
    rpc: { place_order: () => ({ id: 'o9', order_number: 'ORD-1009', total_amount: 160 }), my_order_terms: () => ({ ...TERMS, min_order_value: 0 }) },
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
  assert.match(document.body.textContent, /2 customers waiting for approval/);
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

test('admin: a delivered credit order offers "Record payment", pre-ticked to that invoice (record_payment)', async () => {
  const delivered = { ...ORDER, status: 'delivered', due_date: '2026-10-13', restaurant_id: 'r1' };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    tables: { orders: [delivered], order_status_history: [] },
    rpc: { admin_dashboard_stats: () => ({ pending_restaurants: 0 }), admin_list_users: () => [],
      customer_receivables: () => ({ name: 'Spice Hut', outstanding: 160, overdue: 0, unapplied_credit: 0, exposure: 160, credit_limit: null,
        open_items: [{ kind: 'order', id: 'o1', number: 'ORD-1001', item_date: '2026-10-06', due_date: '2026-10-13', amount: 160, allocated: 0, balance: 160, method: 'credit', days_overdue: 0 }], unapplied: [] }),
      record_payment: () => ({ receipt_number: 'RCT-1000', unallocated: 0 }) },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/admin/main.js');
  (await waitFor(() => document.querySelector('[data-order="o1"]'))).click();
  const pay = await waitFor(() => document.querySelector('[data-pay]'));
  assert.match(pay.closest('dd').textContent, /due 13 Oct/);
  pay.click();
  const form = await waitFor(() => document.querySelector('#receipt'));
  assert.equal(form.elements.amount.value, '160');
  assert.equal(form.querySelector('[data-item="o1"]').checked, true, 'the invoice is pre-ticked');
  form.elements.method.value = 'upi'; form.elements.reference.value = 'UTR42';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'record_payment'));
  const call = fake.calls.find((c) => c.name === 'record_payment').args;
  assert.equal(call.p_restaurant_id, 'r1'); assert.equal(call.p_amount, 160); assert.equal(call.p_method, 'upi'); assert.equal(call.p_reference, 'UTR42');
  assert.deepEqual(call.p_allocations, [{ order_id: 'o1', amount: 160 }]);
});

test('admin: inventory lists stock levels and receives stock via receive_goods (shared GRN form)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } },
    profile: ADMIN,
    tables: { products: PRODUCTS, suppliers: [{ id: 's1', name: 'Farm Co', is_active: true }],
      // Per-warehouse figures (migration 006) mirror the product totals above.
      warehouse_stock: PRODUCTS.map((p) => ({ warehouse_id: 'wh-1', product_id: p.id, qty: p.stock_qty })) },
    rpc: { admin_dashboard_stats: () => ({ pending_restaurants: 0 }), receive_goods: () => ({ grn_number: 'GRN-1000' }) },
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
  const qty = form.querySelector('[data-field="qty_accepted"]');
  qty.value = '25'; qty.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  form.querySelector('[name=supplier]').value = 's1';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'receive_goods'));
  const call = fake.calls.find((c) => c.name === 'receive_goods');
  assert.deepEqual(call.args.p_items, [{ product_id: 'p3', qty_accepted: 25, qty_rejected: 0, unit_cost: null, grade: null, reject_reason: null }]);
  assert.equal(call.args.p_supplier_id, 's1');
  assert.equal(call.args.p_source, 'direct', 'Inventory → Receive stock is a direct receipt (no PO)');
  assert.equal(call.args.p_po_id, null);
  assert.equal(fake.calls.some((c) => c.name === 'receive_stock'), false, 'the old receive_stock path is no longer used by the UI');
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


// ============================================================================
// Migration 006: cities, sectors, roles & permissions, audit log
// ============================================================================

test('admin: a picker sees only the Orders menu and gets "No access" on other routes', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-pick', email: 'p@x.com' } },
    profile: PICKER,
    tables: { orders: [] },
    rpc: ADMIN_RPC,
  });
  location.hash = '#team';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.nav-link'));
  assert.deepEqual([...document.querySelectorAll('.nav-link')].map((a) => a.textContent.trim()), ['Orders']);
  await waitFor(() => /No access/.test(document.querySelector('#view').textContent));
});

test('admin: locations screen lists the city, warehouse and pin codes, and adds a pin code', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: ADMIN_RPC,
  });
  location.hash = '#locations';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-add-zone]'));
  const text = document.body.textContent;
  assert.match(text, /Visakhapatnam/);
  assert.match(text, /Vizag main warehouse/);
  assert.match(text, /530001/);
  document.querySelector('[data-add-zone="wh-1"]').click();
  const form = await waitFor(() => document.querySelector('#loc-form'));
  form.querySelector('[name=pincode]').value = '530016';
  form.querySelector('[name=area_name]').value = 'MVP Colony';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'insert' && c.table === 'service_zones'));
  assert.deepEqual(fake.calls.find((c) => c.table === 'service_zones').payload, { warehouse_id: 'wh-1', pincode: '530016', area_name: 'MVP Colony', is_active: true });
});

test('admin: sectors screen saves edited terms', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: ADMIN_RPC,
  });
  location.hash = '#sectors';
  await importFresh('web/js/pages/admin/main.js');
  const row = await waitFor(() => document.querySelector('tr[data-code="restaurant"]'));
  row.querySelector('[name=min_order_value]').value = '2500';
  row.querySelector('[name=needs_po_reference]').checked = true;
  row.querySelector('[data-save]').click();
  await waitFor(() => fake.calls.some((c) => c.table === 'sectors'));
  const call = fake.calls.find((c) => c.table === 'sectors');
  assert.equal(call.type, 'update');
  assert.equal(call.payload.min_order_value, 2500);
  assert.equal(call.payload.needs_po_reference, true);
  assert.deepEqual(call.filters, [['code', 'restaurant']]);
});

test('admin: roles screen shows the matrix and a super admin can tick a permission', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: ADMIN_RPC,
  });
  location.hash = '#roles';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.matrix'));
  assert.equal(document.querySelector('#role-select').value, 'picker', 'first editable role selected');
  const ordersEdit = document.querySelector('[data-module="orders"][data-action="edit"]');
  assert.equal(ordersEdit.checked, true, 'seeded permission is ticked');
  const paymentsView = document.querySelector('[data-module="payments"][data-action="view"]');
  assert.equal(paymentsView.checked, false);
  paymentsView.checked = true;
  paymentsView.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => fake.calls.some((c) => c.table === 'role_permissions'));
  assert.deepEqual(fake.calls.find((c) => c.table === 'role_permissions').payload, { team_role: 'picker', module: 'payments', action: 'view' });
});

test('admin: roles screen is read-only for a non-super-admin', async () => {
  const cityManager = { ...PICKER, team_role: 'city_manager' };
  const { document, location } = setup({
    session: { user: { id: 'u-pick', email: 'p@x.com' } }, profile: cityManager,
    tables: { role_permissions: [{ team_role: 'city_manager', module: 'team', action: 'view' }, { team_role: 'city_manager', module: 'settings', action: 'view' }] },
    rpc: ADMIN_RPC,
  });
  location.hash = '#roles';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.matrix'));
  assert.ok(document.querySelectorAll('.matrix input:not([disabled])').length === 0, 'no editable tick boxes');
  assert.match(document.body.textContent, /Only a super admin can change/);
});

test('admin: audit log lists changes in plain words', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { audit_log: [
      { id: 2, table_name: 'products', row_id: 'p1-uuid', action: 'update', changed_by: 'u-admin', changed_at: '2026-10-15T05:00:00Z', changes: { price: { old: 32, new: 33 } } },
      { id: 1, table_name: 'orders', row_id: 'o1-uuid', action: 'insert', changed_by: null, changed_at: '2026-10-15T04:00:00Z', changes: { order_number: 'ORD-1001' } },
    ] },
    rpc: ADMIN_RPC,
  });
  location.hash = '#audit';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.diff'));
  const text = document.body.textContent;
  assert.match(text, /Asha Admin/);
  assert.match(text, /price/);
  assert.match(text, /33/);
  assert.match(text, /created/);
  assert.match(text, /system/);
});

test('admin: customers screen approves through set_customer_status and saves terms', async () => {
  const pendingCustomer = { ...RESTAURANT, status: 'pending' };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { restaurants: [pendingCustomer] },
    rpc: { ...ADMIN_RPC, admin_outstanding_balances: () => [], set_customer_status: () => null },
  });
  location.hash = '#customers';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-terms]'));
  assert.match(document.body.textContent, /Restaurants & cloud kitchens/);

  document.querySelector('[data-terms="r1"]').click();
  const form = await waitFor(() => document.querySelector('#terms-form'));
  form.querySelector('[name=sector_code]').value = 'defence';
  form.querySelector('[name=min_order_value]').value = '5000';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.table === 'restaurants' && c.type === 'update'));
  const saved = fake.calls.find((c) => c.table === 'restaurants').payload;
  assert.equal(saved.sector_code, 'defence');
  assert.equal(saved.min_order_value, 5000);
  assert.equal(saved.credit_days, null, 'blank override stays null');
  assert.equal(saved.warehouse_id, 'wh-1');

  (await waitFor(() => document.querySelector('[data-set="approved"]'))).click();
  await waitFor(() => fake.calls.some((c) => c.name === 'set_customer_status'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'set_customer_status').args, { p_restaurant_id: 'r1', p_status: 'approved' });
});

test('admin: inventory receives stock into the chosen warehouse (p_warehouse_id)', async () => {
  const second = { id: 'wh-2', city_id: 'city-vz', name: 'Gajuwaka store', is_default: false, is_active: true };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { products: PRODUCTS, suppliers: [], warehouses: [WAREHOUSE, second],
      warehouse_stock: [{ warehouse_id: 'wh-2', product_id: 'p1', qty: 7 }] },
    rpc: { ...ADMIN_RPC, receive_goods: () => ({ grn_number: 'GRN-1001' }) },
  });
  location.hash = '#inventory';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#warehouse'));
  const select = document.querySelector('#warehouse');
  select.value = 'wh-2'; select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => /Gajuwaka store/.test(document.querySelector('.page-head').textContent));
  assert.match(document.body.textContent.replace(/\s+/g, ' '), /Tomato.*7 kg/, 'per-warehouse quantity shown');

  document.querySelector('#receive').click();
  const form = await waitFor(() => document.querySelector('#grn'));
  assert.equal(form.querySelector('[name=warehouse]').value, 'wh-2', 'GRN defaults to the selected warehouse');
  const product = form.querySelector('[data-field="product_id"]');
  product.value = 'p1'; product.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  const qty = form.querySelector('[data-field="qty_accepted"]');
  qty.value = '10'; qty.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'receive_goods'));
  assert.equal(fake.calls.find((c) => c.name === 'receive_goods').args.p_warehouse_id, 'wh-2');
});

test('admin: team invite sends the team role; saving a row calls admin_set_team_member', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    rpc: { ...ADMIN_RPC, admin_list_users: () => [ADMIN, { ...PICKER, email: 'p@x.com', created_at: '2026-10-01T00:00:00Z' }], 'invite-staff': () => ({ ok: true }), admin_set_team_member: () => null },
  });
  location.hash = '#team';
  await importFresh('web/js/pages/admin/main.js');
  const form = await waitFor(() => document.querySelector('#invite-form'));
  form.querySelector('[name=email]').value = 'new@x.com';
  form.querySelector('[name=role]').value = 'admin';
  form.querySelector('[name=teamRole]').value = 'picker';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'function'));
  assert.equal(fake.calls.find((c) => c.type === 'function').body.team_role, 'picker');

  const row = await waitFor(() => document.querySelector('tr[data-row="u-pick"]'));
  row.querySelector('[data-city]').value = 'city-vz';
  row.querySelector('[data-save]').click();
  await waitFor(() => fake.calls.some((c) => c.name === 'admin_set_team_member'));
  const args = fake.calls.find((c) => c.name === 'admin_set_team_member').args;
  assert.equal(args.p_user, 'u-pick');
  assert.equal(args.p_team_role, 'picker');
  assert.equal(args.p_city_id, 'city-vz');
  assert.equal(args.p_warehouse_id, null);
});

test('admin: orders detail shows the PO reference and delivery fee', async () => {
  const order = { ...ORDER, po_reference: 'PO/2026/0042', delivery_fee: 99, total_amount: 259, sector_code: 'defence', city_id: 'city-vz' };
  const { document, location } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { orders: [order], order_status_history: [] }, rpc: ADMIN_RPC,
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/admin/main.js');
  (await waitFor(() => document.querySelector('[data-order="o1"]'))).click();
  await waitFor(() => document.querySelector('.kv'));
  const text = document.body.textContent.replace(/\s+/g, ' ');
  assert.match(text, /PO\/2026\/0042/);
  assert.match(text, /Delivery fee/);
  assert.match(text.replace(/\s/g, ''), /₹99\.00/);
  assert.match(text, /Army cantonments/);
});

test('restaurant: cart warns below the minimum order, adds the fee, and sends the PO number', async () => {
  const { document, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } },
    profile: RESTAURANT_USER,
    tables: { restaurants: [{ ...RESTAURANT, sector_code: 'defence' }], products: PRODUCTS, orders: [] },
    rpc: {
      place_order: () => ({ id: 'o9', order_number: 'ORD-1009', total_amount: 259, delivery_fee: 99 }),
      my_order_terms: () => ({ ...TERMS, needs_po_reference: true, sector_name: 'Army cantonments & unit messes' }),
    },
  });
  localStorage.clear();
  const cart = await import('../web/js/pages/restaurant/cart.js');
  cart._reset();
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-add="p1"]'));
  document.querySelector('[data-add="p1"]').click();               // 5 kg x 32 = 160, below the 2000 minimum
  document.querySelector('#open-cart').click();
  const place = await waitFor(() => document.querySelector('#place:not([disabled])'));
  const drawer = document.querySelector('.drawer').textContent.replace(/\s+/g, ' ');
  assert.match(drawer, /Add ₹1,840\.00 more/);
  assert.match(drawer, /Delivery fee/);
  assert.match(drawer.replace(/\s/g, ''), /Total₹259\.00/);
  assert.match(drawer, /Purchase order/);

  place.click();                                                    // no PO yet: blocked in the browser
  assert.equal(fake.calls.some((c) => c.name === 'place_order'), false);
  const po = document.querySelector('#po');
  po.value = 'IND/77'; po.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  place.click();
  await waitFor(() => fake.calls.some((c) => c.name === 'place_order'));
  assert.equal(fake.calls.find((c) => c.name === 'place_order').args.p_po_reference, 'IND/77');
});

test('restaurant: with no delivery fee an order below the minimum cannot be placed', async () => {
  const { document } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } },
    profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, orders: [] },
    rpc: { my_order_terms: () => ({ ...TERMS, delivery_fee_below_mov: 0 }) },
  });
  localStorage.clear();
  (await import('../web/js/pages/restaurant/cart.js'))._reset();
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-add="p1"]'));
  document.querySelector('[data-add="p1"]').click();
  document.querySelector('#open-cart').click();
  await waitFor(() => document.querySelector('#place'));
  assert.equal(document.querySelector('#place').disabled, true);
  assert.match(document.querySelector('.drawer').textContent, /Minimum order is ₹2,000\.00/);
});

test('login: registration sends city, pin code and sector to sign-up', async () => {
  const { document, fake } = setup({ body: '<div id="auth-root" data-role="restaurant"></div>' });
  await importFresh('web/js/pages/login.js');
  await waitFor(() => document.querySelector('[data-mode="register"]')).then((b) => b.click());
  const form = await waitFor(() => document.querySelector('[name=pincode]') && document.querySelector('#form'));
  assert.equal(form.querySelector('[name=cityId]').value, 'city-vz');
  const set = (name, value) => { form.querySelector(`[name=${name}]`).value = value; };
  set('restaurantName', 'New Kitchen'); set('fullName', 'Nik'); set('phone', '9000000000'); set('address', '1 Beach Rd');
  set('pincode', '530001'); set('email', 'n@x.com'); set('password', 'secret123');
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'signUp'));
  const data = fake.calls.find((c) => c.type === 'signUp').payload.options.data;
  assert.equal(data.city_id, 'city-vz');
  assert.equal(data.pincode, '530001');
  assert.equal(data.sector_code, 'restaurant');
});

test('landing: pin-code check calls check_pincode and shows the answer', async () => {
  const { document, fake } = setup({
    tables: { products: PRODUCTS },
    body: '<div id="categories"></div><div id="featured"></div><form id="pin-check"><input id="pin-input" value="530001" pattern="[1-9][0-9]{5}"><button type="submit"></button><p id="pin-result"></p></form>',
    rpc: { check_pincode: ({ p_pincode }) => ({ delivers: p_pincode === '530001', city: 'Visakhapatnam', area: 'GPO' }) },
  });
  await importFresh('web/js/pages/landing.js');
  await waitFor(() => document.querySelector('.category-tile'));
  document.querySelector('#pin-check').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('#pin-result').textContent);
  assert.match(document.querySelector('#pin-result').textContent, /Yes — we deliver to 530001 \(GPO\), Visakhapatnam/);
  assert.equal(fake.calls.find((c) => c.name === 'check_pincode').args.p_pincode, '530001');
});

test.after(() => setTimeout(() => process.exit(0), 50)); // delivery page leaves a polling timer running

// -----------------------------------------------------------------------------
// Migration 008 + 009: all sectors on the sign-up form; pricing engine screens
// -----------------------------------------------------------------------------

test('login: every sector that may self-register is offered, with its description as a hint', async () => {
  const { document } = setup({ body: '<div id="auth-root" data-role="restaurant"></div>' });
  await importFresh('web/js/pages/login.js');
  await waitFor(() => document.querySelector('[data-mode="register"]')).then((b) => b.click());
  const select = await waitFor(() => document.querySelector('[name=sectorCode]'));
  assert.deepEqual([...select.options].map((o) => o.value), ['restaurant', 'defence'], 'retail is switched off in the fixture, the other two show');
  select.value = 'defence';
  select.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('#sector-hint').textContent, 'Contract rates, PO on every order');
  assert.match(document.querySelector('#form').textContent, /Business \/ outlet name/);
});

test('admin: price board lists products with flags, recalculates a typed quote locally, and publishes the selected row', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: PRICING_RPC,
    tables: { products: PRODUCTS },
  });
  location.hash = '#pricing';
  await importFresh('web/js/pages/admin/main.js');
  const row = await waitFor(() => document.querySelector('tr[data-id="p1"]'));
  assert.ok(fake.calls.some((c) => c.name === 'publish_due_prices'), 'due scheduled prices are applied when the board opens');
  assert.match(row.textContent, /Held at benchmark cap/);
  assert.equal(row.querySelector('[data-price]').value, '24', 'suggested price from the database is the starting value');
  assert.match(document.querySelector('tr[data-id="p3"]').textContent, /No cost on file/);
  assert.match(document.querySelector('.page-head').textContent, /1 without a cost/);

  // Typing a quote of 30 → cost 30 → landed 32.61 → ×1.15 = 37.5 → cap 24.2 → 24.0 still; margin shrinks and the guard flags it.
  const quote = row.querySelector('[data-quote="p1"]');
  quote.value = '30';
  quote.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.match(row.textContent, /Below cost/, 'cost 32.61 against a capped price of 24');
  quote.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'upsert' && c.table === 'product_pricing'));
  assert.equal(fake.calls.find((c) => c.table === 'product_pricing').payload.supplier_quote, 30);

  // Publish the tomato row at a typed price of 26.
  const price = row.querySelector('[data-price="p1"]');
  price.value = '26';
  price.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  document.querySelector('#publish').click();
  const form = await waitFor(() => document.querySelector('#publish-form'));
  form.querySelector('[name=reason]').value = 'morning board';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'apply_prices'));
  const call = fake.calls.find((c) => c.name === 'apply_prices').args;
  assert.deepEqual(call.p_items, [{ product_id: 'p1', price: 26 }]);
  assert.equal(call.p_reason, 'morning board');
  assert.equal(call.p_effective_at, null);
});

test('admin: a picker has no Pricing menu and sees "No access" on #pricing', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-pick', email: 'p@x.com' } }, profile: PICKER, rpc: { ...ADMIN_RPC, admin_dashboard_stats: () => ({}) },
  });
  location.hash = '#pricing';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#view .empty'));
  assert.match(document.querySelector('#view').textContent, /No access/);
  assert.ok(!document.querySelector('.app-nav a[href="#pricing"]'));
});

test('admin: rules screen shows the category rule and saving a change inserts a new effective-dated row', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: PRICING_RPC,
  });
  location.hash = '#pricing-rules';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.rule-card'));
  const cards = [...document.querySelectorAll('.rule-card')];
  assert.equal(cards.length, 3, 'global + Vegetables + its sub-category');
  assert.match(cards[1].textContent, /15%/);
  assert.match(cards[1].textContent, /10% above/);
  cards[1].querySelector('[data-edit]').click();
  const form = await waitFor(() => document.querySelector('#rule-form'));
  assert.match(document.querySelector('#test-result').textContent, /1 kg bought at ₹100\.00 → landed ₹108\.70 → sells at ₹125\.00/);
  form.querySelector('[name=markup_pct]').value = '14';
  form.querySelector('[name=effective_from]').value = '2026-11-01';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'insert' && c.table === 'pricing_rules'));
  const closed = fake.calls.find((c) => c.type === 'update' && c.table === 'pricing_rules');
  assert.equal(closed.payload.effective_to, '2026-10-31', 'the old row ends the day before');
  const inserted = fake.calls.find((c) => c.type === 'insert' && c.table === 'pricing_rules').payload;
  assert.equal(inserted.category_id, 'c1');
  assert.equal(inserted.markup_pct, 14);
  assert.equal(inserted.effective_from, '2026-11-01');
  assert.equal(inserted.benchmark_cap_pct, 10);
});

test('admin: benchmarks grid saves typed rates as an upsert keyed by source, product and day', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: PRICING_RPC,
    tables: { products: PRODUCTS, benchmark_prices: [{ id: 1, source_id: 'src-rb', product_id: 'p1', price_date: '2026-10-01', price: 30, market: 'MVP' }] },
  });
  location.hash = '#benchmarks';
  await importFresh('web/js/pages/admin/main.js');
  const row = await waitFor(() => document.querySelector('tr[data-id="p1"]'));
  assert.match(row.textContent, /₹30\.00 on/, 'last entered rate shown');
  row.querySelector('[data-rate="p1"]').value = '22';
  row.querySelector('[data-market="p1"]').value = 'MVP Colony';
  document.querySelector('#save-grid').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'upsert' && c.table === 'benchmark_prices'));
  const saved = fake.calls.find((c) => c.table === 'benchmark_prices').payload;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].product_id, 'p1');
  assert.equal(saved[0].source_id, 'src-rb');
  assert.equal(saved[0].price, 22);
  assert.equal(saved[0].market, 'MVP Colony');
  assert.match(saved[0].price_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('admin: product form has HSN and pack size; a board-priced product keeps its price', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: ADMIN_RPC,
    tables: { products: [{ ...PRODUCTS[0], price_source: 'rule', hsn_code: '0702', pack_size: 1, pack_unit: 'kg' }] },
  });
  location.hash = '#products';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-edit="p1"]')).then((b) => b.click());
  const form = await waitFor(() => document.querySelector('#product-form'));
  assert.equal(form.querySelector('[name=price]').readOnly, true, 'published from the board');
  assert.equal(form.querySelector('[name=hsn_code]').value, '0702');
  form.querySelector('[name=hsn_code]').value = '0406';
  form.querySelector('[name=hsn_code]').dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  assert.equal(form.querySelector('[name=gst_rate]').value, '5', 'HSN fills in its GST rate');
  form.querySelector('[name=pack_size]').value = '500';
  form.querySelector('[name=pack_unit]').value = 'g';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'products'));
  const saved = fake.calls.find((c) => c.table === 'products').payload;
  assert.equal(saved.hsn_code, '0406');
  assert.equal(saved.pack_size, 500);
  assert.equal(saved.pack_unit, 'g');
  assert.equal('price' in saved, false, 'the form does not overwrite a board price');
});

test('restaurant: catalogue shows the benchmark source next to the market rate and can show prices incl. GST', async () => {
  const { document } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: [{ ...PRODUCTS[2], market_price: 360, benchmark_label: 'Distributor rate · 15 Oct' }], company_settings: [{ ...COMPANY, show_prices_incl_gst: true }] },
    rpc: { my_order_terms: () => TERMS },
  });
  await importFresh('web/js/pages/restaurant/main.js');
  const card = await waitFor(() => document.querySelector('.product-card'));
  assert.match(card.textContent, /₹357\.00/, '340 + 5% GST');
  assert.match(card.textContent, /incl\. 5% GST/);
  assert.match(card.textContent, /vs Distributor rate · 15 Oct/);
});

test('invoice: shows the HSN column and the delivery fee line', async () => {
  const order = { ...ORDER, delivery_fee: 99, total_amount: 259, order_items: [{ ...ORDER.order_items[0], hsn_code: '0702' }] };
  const { document, location } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], orders: [order], company_settings: [COMPANY] },
    body: '<div id="invoice"></div>',
  });
  location.search = '?order=o1';
  await importFresh('web/js/pages/invoice.js');
  await waitFor(() => document.querySelector('.invoice-head'));
  assert.match(document.querySelector('#invoice').textContent, /HSN/);
  assert.match(document.querySelector('#invoice tbody').textContent, /0702/);
  assert.match(document.querySelector('.totals').textContent, /Delivery fee/);
});

// -----------------------------------------------------------------------------
// Migration 010: category tree, variants, loose weight, price lists
// -----------------------------------------------------------------------------

const RICE = { id: 'p4', sku: 'GRN-001', name: 'Basmati Rice', price: 110, gst_rate: 5, unit: 'kg', min_order_qty: 25, in_stock: true, is_active: true, stock_qty: 500, low_stock_threshold: 50, category_id: 'c1', categories: { name: 'Vegetables' }, veg_type: 'veg' };
const RICE_BAG = { ...RICE, id: 'p5', sku: 'GRN-001-25', name: 'Basmati Rice (25 kg bag)', price: 2600, unit: 'bag', min_order_qty: 1, parent_product_id: 'p4', variant_label: '25 kg bag', pack_size: 25, pack_unit: 'kg' };
const CUSTOMER_RPC = { my_order_terms: () => TERMS, my_price_list: () => [{ product_id: 'p1', price: 30.4 }] };

test('restaurant: catalogue applies my price list, filters by sub-category, sorts, and groups pack sizes', async () => {
  const { document, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: [...PRODUCTS.map((p) => ({ ...p, veg_type: 'veg' })), RICE, RICE_BAG, { ...PRODUCTS[0], id: 'p6', sku: 'VEG-005', name: 'Coriander', price: 60, category_id: 'c1a', brand: 'Farm', sold_by_weight: true }] },
    rpc: CUSTOMER_RPC,
  });
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelectorAll('.product-card').length);
  assert.ok(fake.calls.some((c) => c.name === 'my_price_list'));
  const tomato = [...document.querySelectorAll('.product-card')].find((c) => c.textContent.includes('Tomato'));
  assert.match(tomato.textContent, /₹30\.40/, 'price from my list');
  assert.match(tomato.textContent, /₹32\.00/, 'published price struck through');
  assert.match(tomato.textContent, /Your price/);
  assert.equal(document.querySelectorAll('.product-card').length, 5, '6 products, the 25 kg bag grouped under rice');
  const rice = [...document.querySelectorAll('.product-card')].find((c) => c.textContent.includes('Basmati'));
  assert.equal(rice.querySelector('[data-pack]').options.length, 2, 'pack picker with two sizes');
  rice.querySelector('[data-pack]').value = 'p5';
  rice.querySelector('[data-pack]').dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  const riceNow = [...document.querySelectorAll('.product-card')].find((c) => c.textContent.includes('Basmati'));
  assert.match(riceNow.textContent, /₹2,600\.00/);
  assert.equal(riceNow.querySelector('[data-add]').dataset.add, 'p5', 'adding puts the chosen pack in the cart');
  // Sub-category chips appear once a parent is chosen; "Leafy greens" narrows to coriander.
  document.querySelector('.chip[data-cat="c1"]').click();
  assert.ok(document.querySelector('#sub-chips .chip[data-cat="c1a"]'));
  document.querySelector('#sub-chips .chip[data-cat="c1a"]').click();
  assert.deepEqual([...document.querySelectorAll('.product-card .product-name')].map((n) => n.textContent), ['Coriander']);
  assert.match(document.querySelector('.product-card').textContent, /billed on packed weight/);
  document.querySelector('.chip[data-cat=""]').click();
  document.querySelector('#sort').value = 'price_desc';
  document.querySelector('#sort').dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('.product-card .product-name').textContent, 'Basmati Rice', 'the 25 kg bag (₹2,600) puts the rice card first');
  document.querySelector('#brand').value = 'Farm';
  document.querySelector('#brand').dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  assert.equal(document.querySelectorAll('.product-card').length, 1);
});

test('restaurant: product page shows details and pack sizes and adds the minimum to the cart', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: [{ ...RICE, grade: 'A', origin: 'Punjab', shelf_life_days: 365, storage_note: 'Dry place', hsn_code: '1006', description: 'Long grain.' }, RICE_BAG] },
    rpc: { ...CUSTOMER_RPC, my_price_list: () => [] },
  });
  location.hash = '#product/p5';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('.product-page'));
  const page = document.querySelector('.product-page');
  assert.match(page.querySelector('h1').textContent, /Basmati Rice/);
  assert.match(page.textContent, /₹2,600\.00/);
  assert.match(page.textContent, /Grade/);
  assert.match(page.textContent, /Punjab/);
  assert.match(page.textContent, /365 days/);
  assert.match(page.textContent, /1006/);
  assert.equal(page.querySelectorAll('[data-pack]').length, 2);
  const before = Number(document.querySelector('#cart-count').textContent);   // the cart module keeps lines across tests
  page.querySelector('#add').click();
  await waitFor(() => document.querySelector('#qty'));
  assert.equal(document.querySelector('#qty').value, '1', 'the 25 kg bag minimum is 1');
  assert.equal(Number(document.querySelector('#cart-count').textContent), before + 1);
});

test('admin: product form carries grade, origin, veg type, pack-size parent and loose-weight flags', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: ADMIN_RPC,
    tables: { products: [RICE, { ...PRODUCTS[0], hsn_code: '0702' }] },
  });
  location.hash = '#products';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-edit="p1"]')).then((b) => b.click());
  const form = await waitFor(() => document.querySelector('#product-form'));
  assert.deepEqual([...form.querySelector('[name=category_id]').options].map((o) => o.textContent), ['Choose…', 'Vegetables', '— Leafy greens'], 'category select shows the tree');
  form.querySelector('[name=category_id]').value = 'c1a';
  form.querySelector('[name=grade]').value = 'A';
  form.querySelector('[name=origin]').value = 'Madanapalle';
  form.querySelector('[name=veg_type]').value = 'veg';
  form.querySelector('[name=shelf_life_days]').value = '5';
  form.querySelector('[name=sold_by_weight]').checked = true;
  form.querySelector('[name=weight_tolerance_pct]').value = '12';
  form.querySelector('[name=parent_product_id]').value = 'p4';
  form.querySelector('[name=variant_label]').value = 'loose';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'products'));
  const saved = fake.calls.find((c) => c.table === 'products').payload;
  assert.equal(saved.category_id, 'c1a');
  assert.equal(saved.grade, 'A');
  assert.equal(saved.origin, 'Madanapalle');
  assert.equal(saved.veg_type, 'veg');
  assert.equal(saved.shelf_life_days, 5);
  assert.equal(saved.sold_by_weight, true);
  assert.equal(saved.weight_tolerance_pct, 12);
  assert.equal(saved.parent_product_id, 'p4');
  assert.equal(saved.variant_label, 'loose');
});

test('admin: CSV upload previews problems and writes one update per row', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: ADMIN_RPC,
    tables: { products: [{ ...PRODUCTS[0], price_source: 'manual' }] },
  });
  location.hash = '#products';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#upload')).then((b) => b.click());
  const input = await waitFor(() => document.querySelector('#csv-file'));
  const File = document.defaultView.File;
  const file = new File(['sku,name,category,price,unit\nVEG-001,,,34,\nNEW-1,Okra,Leafy greens,55,kg\nBAD,Nope,Unknown,1,kg\n'], 'p.csv', { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => document.querySelector('#csv-preview').textContent.includes('updated'));
  assert.match(document.querySelector('#csv-preview').textContent, /1 new, 1 updated, 1 line with a problem/);
  assert.match(document.querySelector('#csv-preview').textContent, /unknown category "Unknown"/);
  document.querySelector('#csv-save').click();
  await waitFor(() => fake.calls.filter((c) => c.table === 'products').length === 2);
  const [update, insert] = fake.calls.filter((c) => c.table === 'products');
  assert.equal(update.type, 'update');
  assert.deepEqual(update.payload, { sku: 'VEG-001', price: 34 });
  assert.equal(insert.type, 'insert');
  assert.equal(insert.payload.category_id, 'c1a');
  assert.equal(insert.payload.name, 'Okra');
});

test('admin: price lists screen creates a list and saves fixed prices as an upsert', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: PRICING_RPC && ADMIN, rpc: PRICING_RPC,
    tables: { products: PRODUCTS, price_lists: [{ id: 'pl1', name: 'Hotels −3 %', city_id: null, sector_code: 'hotel', adjustment_pct: -3, is_active: true, cities: null, sectors: { name: 'Hotels & caterers' } }],
              price_list_items: [{ price_list_id: 'pl1', product_id: 'p3', price: 330 }] },
  });
  location.hash = '#price-lists';
  await importFresh('web/js/pages/admin/main.js');
  const row = await waitFor(() => document.querySelector('tr[data-id="p1"]'));
  assert.match(row.textContent, /₹31\.04/, '32 − 3 %');
  assert.match(document.querySelector('tr[data-id="p3"]').textContent, /fixed/);
  row.querySelector('[data-fixed="p1"]').value = '30';
  document.querySelector('#save-fixed').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'upsert' && c.table === 'price_list_items'));
  assert.deepEqual(fake.calls.find((c) => c.table === 'price_list_items').payload, [{ price_list_id: 'pl1', product_id: 'p1', price: 30, note: null }]);
  document.querySelector('#new-list').click();
  const form = await waitFor(() => document.querySelector('#list-form'));
  form.querySelector('[name=name]').value = 'Vizag defence';
  form.querySelector('[name=city_id]').value = 'city-vz';
  form.querySelector('[name=sector_code]').value = 'defence';
  form.querySelector('[name=adjustment_pct]').value = '-8';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'insert' && c.table === 'price_lists'));
  const inserted = fake.calls.find((c) => c.table === 'price_lists').payload;
  assert.equal(inserted.city_id, 'city-vz');
  assert.equal(inserted.sector_code, 'defence');
  assert.equal(inserted.adjustment_pct, -8);
});

test('admin: a confirmed order shows packed-quantity inputs and sends only the changed lines', async () => {
  const order = { ...ORDER, status: 'confirmed', order_items: [{ id: 'i1', ...ORDER.order_items[0], ordered_quantity: 5 }, { id: 'i2', product_id: 'p3', product_name: 'Paneer', unit: 'kg', unit_price: 340, quantity: 2, ordered_quantity: 2, line_total: 680, gst_rate: 5, tax_amount: 34 }] };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { orders: [order], order_status_history: [] },
    rpc: { ...ADMIN_RPC, set_packed_quantities: () => ({ lines: 1, subtotal: 185.6, total_amount: 185.6 }) },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('tr.clickable')).then((r) => r.click());
  const packed = await waitFor(() => document.querySelector('[data-packed="i1"]'));
  packed.value = '5.8';
  document.querySelector('[data-save-packed]').click();
  await waitFor(() => fake.calls.some((c) => c.name === 'set_packed_quantities'));
  const call = fake.calls.find((c) => c.name === 'set_packed_quantities').args;
  assert.equal(call.p_order_id, 'o1');
  assert.deepEqual(call.p_items, [{ order_item_id: 'i1', packed_quantity: 5.8 }], 'the unchanged paneer line is not sent');
});

test('admin: rules screen shows a sub-category inheriting its parent rule', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, rpc: PRICING_RPC,
  });
  location.hash = '#pricing-rules';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.rule-card.sub'));
  const sub = document.querySelector('.rule-card.sub');
  assert.match(sub.querySelector('h3').textContent, /Vegetables › Leafy greens/);
  assert.match(sub.textContent, /Uses the Vegetables rule/);
  assert.match(sub.textContent, /15%/);
});

// ---------------------------------------------------------------------------
// Procurement (migration 011): buying list → draft POs, approve, receive against
// a PO, mandi cash purchases, rate cards. Numbers follow security_test.sql T45–T48.
// ---------------------------------------------------------------------------
const SUPPLIERS = [{ id: 's1', name: 'Farm Co', phone: '9848012345', is_active: true }, { id: 's2', name: 'Dairy Best', is_active: true }];
const BUYING_ROWS = [
  { product_id: 'p1', sku: 'VEG-001', name: 'Tomato', unit: 'kg', category_name: 'Vegetables', demand_qty: 20.8, demand_orders: 2, free_stock: 180, low_stock_threshold: 20, open_po_qty: 0, suggested_qty: 0, supplier_id: 's1', supplier_name: 'Farm Co', rate: 21, moq: 50, lead_days: 1, latest_cost: 20, avg_cost_30d: 20 },
  { product_id: 'p3', sku: 'DAI-002', name: 'Paneer', unit: 'kg', category_name: 'Dairy', demand_qty: 12, demand_orders: 1, free_stock: 5, low_stock_threshold: 10, open_po_qty: 0, suggested_qty: 17, supplier_id: null, supplier_name: null, rate: null, moq: 1, lead_days: 1, latest_cost: 280, avg_cost_30d: null },
];
const DRAFT_PO = {
  id: 'po1', po_number: 'PO-1000', status: 'draft', supplier_id: 's1', warehouse_id: 'wh-1', city_id: 'city-vz', expected_date: '2026-10-16', notes: null, created_at: '2026-10-15T05:00:00Z',
  suppliers: { name: 'Farm Co', phone: '9848012345' }, warehouses: { name: 'Vizag main warehouse', address: '' },
  purchase_order_items: [{ id: 'poi1', product_id: 'p1', qty_ordered: 60, unit_cost: 21, qty_received: 0, qty_rejected: 0, products: { name: 'Tomato', sku: 'VEG-001', unit: 'kg' } }],
};
const PROCUREMENT_RPC = { ...ADMIN_RPC, buying_list: () => BUYING_ROWS, create_purchase_order: () => ({ id: 'po-new', po_number: 'PO-1001' }), set_purchase_order_status: () => null, receive_goods: () => ({ grn_number: 'GRN-1000', po_status: 'part_received' }) };

test('admin: buying list shows the shortfall and creates one draft PO per supplier from ticked rows', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { products: PRODUCTS, suppliers: SUPPLIERS }, rpc: PROCUREMENT_RPC,
  });
  location.hash = '#procurement';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#create-po'));
  assert.match(document.querySelector('.page-head').textContent, /1 products to buy/);
  const bl = fake.calls.find((c) => c.name === 'buying_list');
  assert.equal(bl.args.p_warehouse_id, 'wh-1'); assert.equal(bl.args.p_cover_days, 1);
  const text = document.body.textContent.replace(/\s+/g, ' ');
  assert.match(text, /PaneerDAI-002 · kg · Dairy 121 order 5 0 10 17 no rate card last ₹280\.00/, 'demand (12, 1 order), free 5, on order 0, alert 10, suggested 17, last cost');
  assert.match(text, /Tomato.*Farm Co.*MOQ 50/, 'preferred supplier and MOQ');
  assert.equal(document.querySelector('[data-qty="p3"]').value, '17', 'suggested = 12 × 1 + 10 − 5 − 0');
  assert.equal(document.querySelector('#create-po').disabled, true, 'nothing ticked yet');

  // Ten days of cover recalculates locally (no round trip): tomato 20.8 × 10 + 20 − 180 = 48 → MOQ 50.
  const cover = document.querySelector('#cover');
  cover.value = '10'; cover.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('[data-qty="p1"]'));
  assert.equal(document.querySelector('[data-qty="p1"]').value, '50');
  assert.equal(fake.calls.filter((c) => c.name === 'buying_list').length, 1, 'cover days do not re-query');

  for (const id of ['p1', 'p3']) {
    const tick = document.querySelector(`[data-pick="${id}"]`);
    tick.checked = true; tick.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  }
  await waitFor(() => /Create purchase orders \(2\)/.test(document.querySelector('#create-po').textContent));
  document.querySelector('#create-po').click();
  const form = await waitFor(() => document.querySelector('#po-create'));
  assert.equal(form.querySelectorAll('.card').length, 2, 'one group per supplier');
  form.querySelector('[name="supplier-1"]').value = 's2';   // paneer has no preferred supplier → choose one
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.filter((c) => c.name === 'create_purchase_order').length === 2);
  const [a, b] = fake.calls.filter((c) => c.name === 'create_purchase_order').map((c) => c.args);
  assert.equal(a.p_supplier_id, 's1'); assert.equal(a.p_warehouse_id, 'wh-1');
  assert.deepEqual(a.p_items, [{ product_id: 'p1', quantity: 50, unit_cost: 21 }]);
  assert.equal(b.p_supplier_id, 's2');
  assert.deepEqual(b.p_items, [{ product_id: 'p3', quantity: 125, unit_cost: null }], '12 × 10 + 10 − 5 at ten days of cover; no rate card → cost left to the database');
});

test('admin: purchase order detail approves a draft (set_purchase_order_status → sent) and receives against it', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { products: PRODUCTS, suppliers: SUPPLIERS, purchase_orders: [DRAFT_PO] }, rpc: PROCUREMENT_RPC,
  });
  location.hash = '#purchase-orders';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-open="po1"]'));
  assert.match(document.body.textContent, /PO-1000/);
  document.querySelector('[data-open="po1"]').click();
  await waitFor(() => document.querySelector('[data-status="sent"]'));
  assert.match(document.querySelector('.modal').textContent.replace(/\s+/g, ' '), /Tomato.*60 kg.*₹21/);
  assert.equal(document.querySelector('[data-receive]'), null, 'a draft cannot be received against');
  document.querySelector('[data-status="sent"]').click();
  const yes = await waitFor(() => document.querySelector('[data-yes]'));
  yes.click();
  await waitFor(() => fake.calls.some((c) => c.name === 'set_purchase_order_status'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'set_purchase_order_status').args, { p_po_id: 'po1', p_status: 'sent' });

  // Once sent, "Receive goods" opens the shared GRN form prefilled with the outstanding lines.
  fake.tables.purchase_orders[0].status = 'sent';
  await waitFor(() => !document.querySelector('.modal'));
  document.querySelector('[data-open="po1"]').click();
  const receive = await waitFor(() => document.querySelector('[data-receive]'));
  assert.match(document.querySelector('.modal').textContent, /Share on WhatsApp/);
  receive.click();
  const grn = await waitFor(() => document.querySelector('#grn'));
  assert.match(grn.textContent, /Tomato/);
  const accepted = grn.querySelector('[data-field="qty_accepted"]');
  assert.equal(accepted.value, '60', 'prefilled with the outstanding quantity');
  accepted.value = '55'; accepted.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  const rejected = grn.querySelector('[data-field="qty_rejected"]');
  rejected.value = '5'; rejected.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  grn.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /reason/i.test(document.querySelector('#grn-error').textContent));
  const reason = grn.querySelector('[data-field="reject_reason"]');
  reason.value = 'bruised'; reason.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  grn.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'receive_goods'));
  const call = fake.calls.find((c) => c.name === 'receive_goods').args;
  assert.equal(call.p_po_id, 'po1'); assert.equal(call.p_source, 'po'); assert.equal(call.p_warehouse_id, 'wh-1');
  assert.deepEqual(call.p_items, [{ product_id: 'p1', qty_accepted: 55, qty_rejected: 5, unit_cost: 21, grade: null, reject_reason: 'bruised' }]);
});

test('admin: a mandi cash purchase needs a bill amount and is recorded as source mandi', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { products: PRODUCTS, suppliers: SUPPLIERS }, rpc: PROCUREMENT_RPC,
  });
  location.hash = '#receipts';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#mandi'));
  assert.match(document.body.textContent, /No receipts yet/);
  document.querySelector('#mandi').click();
  const grn = await waitFor(() => document.querySelector('#grn'));
  assert.ok(grn.querySelector('[name=bill_amount]'), 'bill amount field only on mandi purchases');
  assert.ok(grn.querySelector('#bill-photo'), 'bill photo upload');
  const product = grn.querySelector('[data-field="product_id"]');
  product.value = 'p1'; product.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  const qty = grn.querySelector('[data-field="qty_accepted"]');
  qty.value = '40'; qty.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  const cost = grn.querySelector('[data-field="unit_cost"]');
  cost.value = '18.5'; cost.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  grn.querySelector('[name=bill_amount]').value = '740';
  grn.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'receive_goods'));
  const call = fake.calls.find((c) => c.name === 'receive_goods').args;
  assert.equal(call.p_source, 'mandi'); assert.equal(call.p_bill_amount, 740); assert.equal(call.p_paid_cash, true); assert.equal(call.p_supplier_id, null);
  assert.deepEqual(call.p_items, [{ product_id: 'p1', qty_accepted: 40, qty_rejected: 0, unit_cost: 18.5, grade: null, reject_reason: null }]);
});

test('admin: rate cards save changed rows only (upsert on supplier_products)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { products: PRODUCTS, suppliers: SUPPLIERS,
      supplier_products: [{ id: 'sp1', supplier_id: 's1', product_id: 'p1', price: 21, moq: 50, lead_days: 1, valid_from: '2026-10-01', valid_to: null, is_preferred: true, suppliers: { name: 'Farm Co' } }] },
    rpc: ADMIN_RPC,
  });
  location.hash = '#rate-cards';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#save-all'));
  assert.equal(document.querySelector('[data-price="p1"]').value, '21');
  assert.equal(document.querySelector('[data-preferred="p1"]').checked, true);
  document.querySelector('[data-price="p3"]').value = '290';
  document.querySelector('[data-moq="p3"]').value = '10';
  document.querySelector('#save-all').click();
  await waitFor(() => fake.calls.some((c) => c.table === 'supplier_products'));
  const writes = fake.calls.filter((c) => c.table === 'supplier_products');
  assert.equal(writes.length, 1, 'the unchanged tomato rate is not re-sent');
  assert.equal(writes[0].type, 'upsert');
  assert.equal(writes[0].payload.product_id, 'p3'); assert.equal(writes[0].payload.price, 290); assert.equal(writes[0].payload.moq, 10);
  assert.equal(writes[0].payload.supplier_id, 's1');
});

test('admin: a picker has no Procurement menu and sees "No access" on #procurement', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-pick', email: 'p@x.com' } }, profile: PICKER, rpc: PROCUREMENT_RPC,
  });
  location.hash = '#procurement';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => /No access/.test(document.querySelector('#view').textContent));
  assert.equal(document.querySelector('nav a[href="#procurement"]'), null);
});

// ---------------------------------------------------------------------------
// Fulfilment (migration 012) and Orders + (migration 013) screens.
// ---------------------------------------------------------------------------
const TOMORROW = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const FULFIL_RPC = { ...ADMIN_RPC, pick_list: () => [], expiring_batches: () => [], driver_cash_summary: () => [] };

test('admin: pick list shows what to pick and a near-expiry write-off', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { products: PRODUCTS, warehouses: [WAREHOUSE] },
    rpc: { ...ADMIN_RPC,
      pick_list: () => [{ product_id: 'p1', sku: 'VEG-001', name: 'Tomato', unit: 'kg', category_name: 'Vegetables', pick_qty: 40, orders: 3, free_stock: 30, short: 10 }],
      expiring_batches: () => [{ id: 'b1', name: 'Tomato', unit: 'kg', batch_no: 'OLD', remaining_qty: 5, expiry_date: '2026-10-10', days_left: -6, expired: true }],
      write_off_expired: () => ({ batches: 1, qty: 5 }) },
  });
  location.hash = '#fulfilment';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.table'));
  const text = document.body.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Tomato.*40.*3.*30.*10/, 'pick quantity, orders, stock and short');
  assert.match(text, /Expiring soon/);
  document.querySelector('#writeoff').click();
  const yes = await waitFor(() => document.querySelector('[data-yes]'));
  yes.click();
  await waitFor(() => fake.calls.some((c) => c.name === 'write_off_expired'));
  assert.equal(fake.calls.find((c) => c.name === 'write_off_expired').args.p_warehouse_id, 'wh-1');
});

test('admin: a picker has no Fulfilment menu and sees "No access" on #fulfilment', async () => {
  const { document, location } = setup({ session: { user: { id: 'u-pick', email: 'p@x.com' } }, profile: PICKER, rpc: FULFIL_RPC });
  location.hash = '#fulfilment';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => /No access/.test(document.querySelector('#view').textContent));
  assert.equal(document.querySelector('nav a[href="#fulfilment"]'), null);
});

test('admin: build a trip from a confirmed order and dispatch it', async () => {
  const order = { ...ORDER, id: 'co1', order_number: 'ORD-2001', status: 'confirmed', delivery_date: TOMORROW, delivery_slot: 'morning', warehouse_id: 'wh-1', city_id: 'city-vz' };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { orders: [order], warehouses: [WAREHOUSE], vehicles: [{ id: 've1', city_id: 'city-vz', registration: 'AP39-1', is_active: true }] },
    rpc: { ...ADMIN_RPC, admin_list_users: () => [ADMIN, DRIVER], create_trip: () => ({ id: 't-new', trip_number: 'TRIP-1' }), dispatch_trip: () => ({ dispatched: 1 }) },
  });
  location.hash = '#trips';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#new'));
  document.querySelector('#new').click();
  const form = await waitFor(() => document.querySelector('#trip-form'));
  await waitFor(() => form.querySelector('[data-pick="co1"]'));
  form.querySelector('[data-pick="co1"]').click();
  await waitFor(() => document.querySelector('[data-pick="co1"]'));   // re-draw
  document.querySelector('[name=driver]').value = 'u-d';
  document.querySelector('#trip-form').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'create_trip'));
  const call = fake.calls.find((c) => c.name === 'create_trip').args;
  assert.deepEqual(call.p_order_ids, ['co1']);
  assert.equal(call.p_driver_id, 'u-d');
});

test('admin: driver cash shows the in-hand total and settles it', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    rpc: { ...ADMIN_RPC, driver_cash_summary: () => [{ driver_id: 'u-d', driver_name: 'Dev Driver', collected: 355, settled: 100, in_hand: 255, orders: 2 }], settle_driver_cash: () => null },
  });
  location.hash = '#driver-cash';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-settle="u-d"]'));
  assert.match(document.body.textContent.replace(/\s+/g, ' '), /Dev Driver.*2.*355.*100.*255/);
  document.querySelector('[data-settle="u-d"]').click();
  const form = await waitFor(() => document.querySelector('#settle'));
  form.querySelector('[name=amount]').value = '255';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'settle_driver_cash'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'settle_driver_cash').args, { p_driver_id: 'u-d', p_amount: 255, p_note: null });
});

test('admin: a delivery-charge rule is saved', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, tables: { cities: [CITY] }, rpc: ADMIN_RPC,
  });
  location.hash = '#delivery-charges';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#new'));
  document.querySelector('#new').click();
  const form = await waitFor(() => document.querySelector('#dc'));
  form.querySelector('[name=slot]').value = 'express';
  form.querySelector('[name=fee]').value = '49';
  form.querySelector('[name=free_above]').value = '1500';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.table === 'delivery_charge_rules'));
  const w = fake.calls.find((c) => c.table === 'delivery_charge_rules');
  assert.equal(w.type, 'insert'); assert.equal(w.payload.slot, 'express'); assert.equal(w.payload.fee, 49); assert.equal(w.payload.free_above, 1500);
});

test('admin: resolve an issue and raise a credit note', async () => {
  const issue = { id: 'iss1', order_id: 'co1', restaurant_id: 'r1', kind: 'quality', note: 'bruised', status: 'open', created_at: '2026-10-15T05:00:00Z', orders: { order_number: 'ORD-2001' }, restaurants: { name: 'Spice Hut' } };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { order_issues: [issue], orders: [{ ...ORDER, id: 'co1', total_amount: 419 }] },
    rpc: { ...ADMIN_RPC, resolve_issue: () => ({ status: 'resolved', credit_note: 'CN-1', amount: 50 }) },
  });
  location.hash = '#issues';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-open="iss1"]'));
  document.querySelector('[data-open="iss1"]').click();
  const form = await waitFor(() => document.querySelector('#resolve'));
  form.querySelector('[name=resolution]').value = 'goodwill';
  form.querySelector('[name=credit]').value = '50';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'resolve_issue'));
  const call = fake.calls.find((c) => c.name === 'resolve_issue').args;
  assert.equal(call.p_issue_id, 'iss1'); assert.equal(call.p_credit_amount, 50); assert.equal(call.p_reject, false);
});

test('delivery: driver completes a delivery with the OTP and a doorstep return', async () => {
  const order = { ...ORDER, id: 'od1', order_number: 'ORD-2002', status: 'out_for_delivery', assigned_to: 'u-d',
    order_items: [{ id: 'oi1', product_id: 'p1', product_name: 'Tomato', unit: 'kg', unit_price: 32, quantity: 10, line_total: 320 }] };
  const { document, fake } = setup({
    session: { user: { id: 'u-d', email: 'd@x.com' } }, profile: DRIVER,
    tables: { orders: [order] },
    rpc: { complete_delivery: () => ({ total_amount: 251, returned: 64, cash_collected: 251 }) },
  });
  await importFresh('web/js/pages/delivery/main.js');
  await waitFor(() => document.querySelector('[data-done="od1"]'));
  document.querySelector('[data-done="od1"]').click();
  const form = await waitFor(() => document.querySelector('#pod'));
  form.querySelector('[name=otp]').value = '1234';
  form.querySelector('[data-ret="oi1"]').value = '2';
  form.querySelector('[data-ret="oi1"]').dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  // Migration 023: a delivery cannot be marked done without a POD photo.
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /photo of the delivered items/.test(document.querySelector('#pod-error').textContent));
  assert.ok(!fake.calls.some((c) => c.name === 'complete_delivery'), 'refused without a photo');
  const photo = document.querySelector('#pod-photo');
  Object.defineProperty(photo, 'files', { value: [new document.defaultView.File(['jpg'], 'pod.jpg', { type: 'image/jpeg' })] });
  photo.dispatchEvent(new document.defaultView.Event('change'));
  await waitFor(() => fake.calls.some((c) => c.type === 'upload'));
  await waitFor(() => /Photo attached/.test(document.querySelector('#pod-preview').textContent));
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'complete_delivery'));
  const call = fake.calls.find((c) => c.name === 'complete_delivery').args;
  assert.equal(call.p_otp, '1234');
  assert.match(call.p_photo_path ?? '', /\.jpg$/);
  assert.deepEqual(call.p_returns, [{ order_item_id: 'oi1', qty: 2 }]);
});

test('customer: within the 15-minute window the buttons show with "X min left"; edit calls edit_order', async () => {
  const order = { ...ORDER, id: 'mo1', order_number: 'ORD-2003', status: 'placed', restaurant_id: 'r1',
    created_at: new Date(Date.now() - 2 * 60_000).toISOString(),   // placed 2 min ago
    order_items: [{ id: 'oi1', product_id: 'p1', product_name: 'Tomato', unit: 'kg', unit_price: 32, quantity: 10, ordered_quantity: 10, line_total: 320 }] };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { products: PRODUCTS, restaurants: [RESTAURANT], orders: [order] },
    rpc: { my_order_terms: () => ({ delivers: true, customer_edit_window_minutes: 15 }), my_price_list: () => [], edit_order: () => ({ order_number: 'ORD-2003', total_amount: 484, delivery_fee: 99 }), get_order_history: () => [] },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-order="mo1"]'));
  document.querySelector('[data-order="mo1"]').click();
  const edit = await waitFor(() => document.querySelector('[data-edit]'));
  edit.click();
  const form = await waitFor(() => document.querySelector('#edit'));
  const qty = form.querySelector('[data-qty="0"]');
  qty.value = '15'; qty.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'edit_order'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'edit_order').args.p_items, [{ product_id: 'p1', quantity: 15 }]);
  assert.match(document.body.textContent, /more minute/);
});

test('customer: past the window the buttons are gone and the detail says to call us', async () => {
  const order = { ...ORDER, id: 'old1', order_number: 'ORD-2010', status: 'placed', restaurant_id: 'r1',
    created_at: new Date(Date.now() - 40 * 60_000).toISOString() };   // 40 min ago
  const { document, location } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { products: PRODUCTS, restaurants: [RESTAURANT], orders: [order] },
    rpc: { my_order_terms: () => ({ delivers: true, customer_edit_window_minutes: 15 }), my_price_list: () => [], get_order_history: () => [] },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/restaurant/main.js');
  (await waitFor(() => document.querySelector('[data-order="old1"]'))).click();
  await waitFor(() => document.querySelector('[data-reorder]'));
  assert.equal(document.querySelector('[data-edit]'), null);
  assert.equal(document.querySelector('[data-cancel]'), null);
  assert.match(document.querySelector('.modal-body').textContent, /15-minute window.*passed.*Call us/);
});

test('customer: a defence sector with window 0 shows no buttons and the "call us" notice straight away', async () => {
  const order = { ...ORDER, id: 'df1', order_number: 'ORD-2011', status: 'placed', restaurant_id: 'r1',
    created_at: new Date(Date.now() - 30_000).toISOString() };   // 30 seconds ago
  const { document, location } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { products: PRODUCTS, restaurants: [{ ...RESTAURANT, sector_code: 'defence' }], orders: [order] },
    rpc: { my_order_terms: () => ({ delivers: true, customer_edit_window_minutes: 0 }), my_price_list: () => [], get_order_history: () => [] },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/restaurant/main.js');
  (await waitFor(() => document.querySelector('[data-order="df1"]'))).click();
  await waitFor(() => document.querySelector('[data-reorder]'));
  assert.equal(document.querySelector('[data-edit]'), null);
  assert.equal(document.querySelector('[data-cancel]'), null);
  assert.match(document.querySelector('.modal-body').textContent, /Changes and cancellations go through our team/);
});

test('admin: Sectors screen saves the edit window; blank saves as the default', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    rpc: ADMIN_RPC,
  });
  location.hash = '#sectors';
  await importFresh('web/js/pages/admin/main.js');
  const row = await waitFor(() => document.querySelector('tr[data-code="defence"]'));
  const field = row.querySelector('[name=customer_edit_window_minutes]');
  assert.ok(field, 'the Edit window column exists');
  field.value = '0';
  row.querySelector('[data-save]').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'sectors'));
  assert.equal(fake.calls.find((c) => c.type === 'update' && c.table === 'sectors').payload.customer_edit_window_minutes, 0);
});

test('customer: report an issue on a delivered order', async () => {
  const order = { ...ORDER, id: 'do1', order_number: 'ORD-2004', status: 'delivered', restaurant_id: 'r1' };
  const { document, location, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { products: PRODUCTS, restaurants: [RESTAURANT], orders: [order] },
    rpc: { my_order_terms: () => ({ delivers: true }), my_price_list: () => [], report_issue: () => ({ id: 'iss9' }) },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-order="do1"]'));
  document.querySelector('[data-order="do1"]').click();
  const btn = await waitFor(() => document.querySelector('[data-issue]'));
  btn.click();
  const form = await waitFor(() => document.querySelector('#issue'));
  form.querySelector('[name=kind]').value = 'short';
  form.querySelector('[name=note]').value = 'one crate missing';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'report_issue'));
  const call = fake.calls.find((c) => c.name === 'report_issue').args;
  assert.equal(call.p_order_id, 'do1'); assert.equal(call.p_kind, 'short');
});

test('admin: place an order on behalf of a customer (place_order_for)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { products: PRODUCTS, restaurants: [RESTAURANT] },
    rpc: { ...ADMIN_RPC, place_order_for: () => ({ order_number: 'ORD-2005', total_amount: 419 }) },
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#new-order'));
  document.querySelector('#new-order').click();
  const form = await waitFor(() => document.querySelector('#po-for'));
  form.querySelector('[name=restaurant]').value = 'r1';
  form.querySelector('[data-field="product_id"]').value = 'p1';
  form.querySelector('[data-field="product_id"]').dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  const q = form.querySelector('[data-field="quantity"]');
  q.value = '10'; q.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'place_order_for'));
  const call = fake.calls.find((c) => c.name === 'place_order_for').args;
  assert.equal(call.p_restaurant_id, 'r1');
  assert.deepEqual(call.p_items, [{ product_id: 'p1', quantity: 10 }]);
});

// ---------- Launch control (migration 014) ------------------------------------
const LAUNCH = {
  pricing_mode: 'advanced', stock_mode: 'counted', products_listed: 3, products_in_stock: 2,
  sectors: SECTORS.map((s) => ({ code: s.code, name: s.name, description: s.description, is_active: s.is_active, can_self_register: s.can_self_register, sort_order: s.sort_order,
    customers: s.code === 'restaurant' ? 4 : 0, customers_approved: s.code === 'restaurant' ? 3 : 0, customers_pending: s.code === 'restaurant' ? 1 : 0, orders_30d: s.code === 'restaurant' ? 12 : 0 })),
};

test('admin: Launch screen lists every sector with counts; switching one off asks first and writes is_active', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    rpc: { ...ADMIN_RPC, launch_status: () => LAUNCH },
  });
  location.hash = '#launch';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-live="restaurant"]'));
  const rows = [...document.querySelectorAll('[data-sector]')];
  assert.equal(rows.length, 3, 'every sector in the table');
  assert.match(rows[0].textContent, /4/); assert.match(rows[0].textContent, /1 waiting/); assert.match(rows[0].textContent, /12/);
  const box = document.querySelector('[data-live="restaurant"]');
  box.checked = false; box.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  (await waitFor(() => document.querySelector('[data-yes]'))).click();
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'sectors'));
  const call = fake.calls.find((c) => c.type === 'update' && c.table === 'sectors');
  assert.deepEqual(call.payload, { is_active: false }); assert.deepEqual(call.filters, [['code', 'restaurant']]);
  // Modes: pick simple pricing + simple stock and save → one update on company_settings.
  document.querySelector('[name=pricing_mode][value=simple]').checked = true;
  document.querySelector('[name=stock_mode][value=simple]').checked = true;
  document.querySelector('#modes').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'company_settings'));
  assert.deepEqual(fake.calls.find((c) => c.type === 'update' && c.table === 'company_settings').payload, { pricing_mode: 'simple', stock_mode: 'simple' });
});

test('admin: in lite mode the menu drops Pricing, Inventory and Procurement, #pricing says "Switched off", and the product form folds the details', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { company_settings: [{ ...COMPANY, pricing_mode: 'simple', stock_mode: 'simple' }], products: PRODUCTS },
    rpc: ADMIN_RPC,
  });
  location.hash = '#pricing';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.nav-link'));
  const labels = [...document.querySelectorAll('.nav-link')].map((a) => a.firstChild.textContent.trim());
  assert.deepEqual(labels, ['Dashboard', 'Orders', 'Products', 'Customers', 'Payments', 'Team', 'Settings', 'Audit log', 'Reports', 'Fulfilment']);
  assert.match((await waitFor(() => document.querySelector('.empty'))).textContent, /Switched off/);
  // Products: no "On hand" column; the form shows the essentials and a details fold; saving marks the price a hand price.
  location.hash = '#products';
  document.defaultView.dispatchEvent(new document.defaultView.Event('hashchange'));
  await waitFor(() => document.querySelector('#new'));
  assert.equal([...document.querySelectorAll('th')].some((th) => th.textContent === 'On hand'), false);
  document.querySelector('[data-edit="p1"]').click();
  const form = await waitFor(() => document.querySelector('#product-form'));
  assert.ok(form.querySelector('details.more'), 'details are folded');
  assert.equal(form.querySelector('[name=price]').hasAttribute('readonly'), false);
  assert.equal(form.querySelector('[name=low_stock_threshold]').type, 'hidden', 'no stock alert field in simple stock');
  form.elements.price.value = '35';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'products'));
  const saved = fake.calls.find((c) => c.type === 'update' && c.table === 'products').payload;
  assert.equal(saved.price, 35); assert.equal(saved.price_source, 'manual');
});

test('customer: a sector that is switched off sees why it cannot order; the credit option is disabled with the reason', async () => {
  const { document } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, orders: [] },
    rpc: { my_order_terms: () => ({ ...TERMS, sector_active: false, credit_blocked_reason: 'You have overdue invoices of 239.00. Settle them to order on credit again.', overdue: 239 }) },
  });
  localStorage.clear();
  const cart = await import('../web/js/pages/restaurant/cart.js');
  cart._reset();
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-add="p1"]'));
  assert.match(document.querySelector('.banner').textContent, /not taking orders from Restaurants & cloud kitchens yet/);
  document.querySelector('[data-add="p1"]').click();
  document.querySelector('#open-cart').click();
  const credit = await waitFor(() => document.querySelector('[name="pay"][value="credit"]'));
  assert.equal(credit.disabled, true);
  assert.match(credit.closest('label').textContent, /overdue invoices/);
  assert.equal(document.querySelector('#place').disabled, true, 'ordering is closed for the sector');
});

test('login: a sector that is not live is not offered on the sign-up form', async () => {
  const { document } = setup({ body: '<div id="auth-root" data-role="restaurant"></div>',
    tables: { sectors: SECTORS.map((s) => (s.code === 'defence' ? { ...s, is_active: false } : s)) } });
  await importFresh('web/js/pages/login.js');
  await waitFor(() => document.querySelector('[data-mode="register"]')).then((b) => b.click());
  await waitFor(() => document.querySelector('[name=restaurantName]'));
  assert.equal(document.querySelector('[name=sectorCode]'), null, 'only one sector is live, so there is nothing to choose');
});

test('admin: sectors screen saves the credit limit and the overdue block; the customer terms form sends credit_limit', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { restaurants: [RESTAURANT] }, rpc: { ...ADMIN_RPC, admin_outstanding_balances: () => [] },
  });
  location.hash = '#sectors';
  await importFresh('web/js/pages/admin/main.js');
  const row = await waitFor(() => document.querySelector('tr[data-code="restaurant"]'));
  row.querySelector('[name=credit_limit]').value = '50000';
  row.querySelector('[name=block_credit_when_overdue]').checked = false;
  row.querySelector('[data-save]').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'sectors'));
  const sector = fake.calls.find((c) => c.type === 'update' && c.table === 'sectors').payload;
  assert.equal(sector.credit_limit, 50000); assert.equal(sector.block_credit_when_overdue, false);
  location.hash = '#customers';
  document.defaultView.dispatchEvent(new document.defaultView.Event('hashchange'));
  (await waitFor(() => document.querySelector('[data-terms="r1"]'))).click();
  const form = await waitFor(() => document.querySelector('#terms-form'));
  form.elements.credit_limit.value = '25000';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'restaurants'));
  assert.equal(fake.calls.find((c) => c.type === 'update' && c.table === 'restaurants').payload.credit_limit, 25000);
});

// ---------- Payments & credit (migration 015) ---------------------------------
const SUMMARY_ROW = { restaurant_id: 'r1', name: 'Spice Hut', sector_code: 'restaurant', city_id: 'city-vz', phone: '999', outstanding: 239, open_items: 1,
  current_due: 0, d1_30: 239, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 239, oldest_due: '2026-10-19', unapplied_credit: 0, credit_limit: null, credit_days: 7 };
const ACCOUNT = { restaurant_id: 'r1', name: 'Spice Hut', outstanding: 239, overdue: 239, open_items: 1, unapplied_credit: 0, pending_credit_orders: 0, exposure: 239, oldest_due: '2026-10-19',
  credit_limit: 1000, credit_available: 761,
  open_items: [{ kind: 'order', id: 'o1', number: 'ORD-1001', item_date: '2026-10-12', due_date: '2026-10-19', amount: 289, allocated: 50, balance: 239, method: 'credit', days_overdue: 1 }],
  unapplied: [] };
const RECEIPT = { id: 'pay1', receipt_number: 'RCT-1000', restaurant_id: 'r1', amount: 239, method: 'upi', reference: 'UTR1', received_on: '2026-10-20', note: null, voided_at: null, restaurants: { name: 'Spice Hut' } };

test('admin: receivables shows the ageing table with totals, opens the account and records a receipt (oldest-due preview)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { payments: [RECEIPT] },
    rpc: { ...ADMIN_RPC, receivables_summary: () => [SUMMARY_ROW], customer_receivables: () => ACCOUNT, record_payment: () => ({ receipt_number: 'RCT-1001', unallocated: 0 }) },
  });
  location.hash = '#payments';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-open="r1"]'));
  const text = document.body.textContent.replace(/\s/g, '');
  assert.match(text, /₹239\.00outstanding·₹239\.00overdue/);
  assert.match(document.querySelector('tfoot').textContent.replace(/\s/g, ''), /Total₹239\.00/);
  document.querySelector('[data-open="r1"]').click();
  const modal = await waitFor(() => document.querySelector('.modal-body h2'));
  assert.equal(modal.textContent, 'Spice Hut');
  const body = document.querySelector('.modal-body').textContent.replace(/\s+/g, ' ');
  assert.match(body, /1 day overdue/); assert.match(body, /RCT-1000/); assert.match(body, /₹761\.00 available/);
  document.querySelector('[data-receipt]').click();
  const form = await waitFor(() => document.querySelector('#receipt'));
  form.elements.amount.value = '100'; form.elements.amount.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.match(document.querySelector('#apply-hint').textContent, /ORD-1001 ₹100\.00/, 'preview mirrors oldest-due-first');
  form.elements.method.value = 'cash';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'record_payment'));
  const call = fake.calls.find((c) => c.name === 'record_payment').args;
  assert.equal(call.p_amount, 100); assert.equal(call.p_method, 'cash'); assert.equal(call.p_allocations, null, 'nothing ticked → the database allocates');
});

test('admin: receipts tab lists receipts and voids one with a reason (void_payment)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { payments: [RECEIPT] }, rpc: { ...ADMIN_RPC, void_payment: () => null },
  });
  location.hash = '#payments-receipts';
  await importFresh('web/js/pages/admin/main.js');
  (await waitFor(() => document.querySelector('[data-void="pay1"]'))).click();
  const form = await waitFor(() => document.querySelector('#void'));
  form.elements.reason.value = 'bounced';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.name === 'void_payment'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'void_payment').args, { p_payment_id: 'pay1', p_reason: 'bounced' });
});

test('admin: a picker has no Payments menu and sees "No access" on #payments', async () => {
  const { document, location } = setup({ session: { user: { id: 'u-pick', email: 'p@x.com' } }, profile: PICKER, rpc: ADMIN_RPC });
  location.hash = '#payments';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('.nav-link'));
  assert.equal([...document.querySelectorAll('.nav-link')].some((a) => a.textContent.includes('Payments')), false);
  assert.match((await waitFor(() => document.querySelector('.empty'))).textContent, /No access/);
});

test('customer: the Payments page shows what is owed, open invoices and receipts, and opens a monthly statement', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, payments: [RECEIPT], credit_notes: [{ id: 'cn1', credit_note_number: 'CN-1000', restaurant_id: 'r1', amount: 50, reason: 'bruised', created_at: '2026-10-15T05:00:00Z', orders: { order_number: 'ORD-1000' } }] },
    rpc: { my_order_terms: () => TERMS, customer_receivables: () => ACCOUNT },
  });
  location.hash = '#payments';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('#statement'));
  const text = document.body.textContent.replace(/\s+/g, '');
  assert.match(text, /Youowe₹239\.00/); assert.match(text, /Overdue₹239\.00/); assert.match(text, /₹761\.00available/);
  assert.match(text, /ORD-1001/); assert.match(text, /RCT-1000/); assert.match(text, /CN-1000/);
  assert.equal(document.querySelector('#pay-online'), null, 'no Razorpay key in config → no Pay online button');
  let opened = null;
  document.defaultView.open = (url) => { opened = url; };
  document.querySelector('#statement [name=month]').value = '2026-09';
  document.querySelector('#statement').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(opened, /statement\.html\?customer=r1&from=2026-09-01&to=2026-09-30$/);
});

test('statement: renders opening balance, lines with running balance and closing balance', async () => {
  const { document } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    body: '<div class="print-bar"><form id="range"><input type="date" name="from"><input type="date" name="to"></form></div><main id="statement"></main>',
    tables: { restaurants: [RESTAURANT] },
    rpc: { customer_statement: () => ({ name: 'Spice Hut', address: '12 MG Road', gstin: '', from: '2026-10-01', to: '2026-10-31', opening_balance: 0, closing_balance: -61,
      lines: [{ date: '2026-10-12', kind: 'invoice', number: 'ORD-1001', description: 'Order ORD-1001 (pay later, due 19 Oct)', debit: 289, credit: 0, balance: 289 },
              { date: '2026-10-15', kind: 'credit_note', number: 'CN-1000', description: 'Credit note: bruised', debit: 0, credit: 50, balance: 239 },
              { date: '2026-10-20', kind: 'payment', number: 'RCT-1001', description: 'Receipt (cash)', debit: 0, credit: 300, balance: -61 }] }) },
  });
  location.search = '?customer=r1&from=2026-10-01&to=2026-10-31';
  await importFresh('web/js/pages/statement.js');
  await waitFor(() => document.querySelector('tr.closing'));
  const rows = [...document.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent.trim()));
  assert.equal(rows.length, 5, 'opening + 3 lines + closing');
  assert.deepEqual(rows[1].slice(1, 3), ['Invoice', 'ORD-1001']); assert.deepEqual(rows[1].slice(4), ['₹289.00', '', '₹289.00']);
  assert.deepEqual(rows[3].slice(4), ['', '₹300.00', '-₹61.00']);
  assert.deepEqual(rows[4].slice(2), ['₹289.00', '₹350.00', '-₹61.00']);
});

// ---------- Customer access (migration 016) -----------------------------------
test('login: "email not confirmed" offers to resend the confirmation (auth.resend) and so does the register screen', async () => {
  const { document, fake } = setup({});
  await importFresh('web/js/pages/login.js');
  await waitFor(() => document.querySelector('#form'));
  document.querySelector('[name=email]').value = 'unconfirmed@example.com';
  document.querySelector('[name=password]').value = 'whatever1';
  document.querySelector('#form').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('#error').textContent);
  assert.match(document.querySelector('#error').textContent, /not confirmed yet/);
  const box = document.querySelector('#not-confirmed');
  assert.equal(box.hidden, false, 'the resend box shows');
  assert.match(box.textContent, /Call us/);
  box.querySelector('[data-resend]').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'resend'));
  const call = fake.calls.find((c) => c.type === 'resend').payload;
  assert.equal(call.type, 'signup'); assert.equal(call.email, 'unconfirmed@example.com');
  await waitFor(() => /Sent again/.test(document.body.textContent));
});

test('admin: Customers shows who cannot sign in yet and Access confirms the email / gets a password link (customer-access function)', async () => {
  const logins = [{ restaurant_id: 'r1', owner_id: 'u-r', email: 'mess1@army.in', email_confirmed: false, confirmation_sent_at: '2026-10-21T08:36:15Z', last_sign_in_at: null, user_created_at: '2026-10-21T08:36:12Z' }];
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { restaurants: [{ ...RESTAURANT, status: 'pending', phone: '+91 99000 11111' }] },
    rpc: { ...ADMIN_RPC, admin_outstanding_balances: () => [], admin_customer_logins: () => logins,
      'customer-access': (body) => (body.action === 'password_link' ? { ok: true, action: 'password_link', email: 'mess1@army.in', link: 'https://x.supabase.co/auth/v1/verify?token=abc' } : { ok: true, action: body.action, email: 'mess1@army.in' }) },
  });
  location.hash = '#customers';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-access="r1"]'));
  assert.match(document.querySelector('#unconfirmed-banner').textContent, /1 customer cannot sign in yet/);
  assert.match(document.querySelector('[data-row="r1"]').textContent, /email not confirmed/);
  document.querySelector('[data-access="r1"]').click();
  const dialog = await waitFor(() => document.querySelector('#access'));
  dialog.querySelector('[data-act="confirm_email"]').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'function' && c.name === 'customer-access'));
  const first = fake.calls.find((c) => c.type === 'function' && c.name === 'customer-access').body;
  assert.equal(first.action, 'confirm_email'); assert.equal(first.restaurant_id, 'r1');
  await waitFor(() => /is confirmed/.test(dialog.textContent));
  assert.equal(dialog.querySelector('[data-act="confirm_email"]').disabled, true);
  dialog.querySelector('[data-act="password_link"]').click();
  await waitFor(() => document.querySelector('#access-link'));
  assert.equal(document.querySelector('#access-link').value, 'https://x.supabase.co/auth/v1/verify?token=abc');
  assert.match(dialog.querySelector('a[href^="https://wa.me/919900011111"]').href, /token%3Dabc/);
  const form = dialog.querySelector('#set-pass');
  form.elements.password.value = 'mess12345';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.filter((c) => c.name === 'customer-access').length === 3);
  assert.equal(fake.calls.filter((c) => c.name === 'customer-access')[2].body.password, 'mess12345');
});

// ---------- Notifications & support (migration 018) ---------------------------
const NOTIFY_SETTING = { event: 'order_placed',   // no id column: rows are keyed by (event, sector_code)
  sector_code: null, sms_enabled: true, email_enabled: false,
  sms_template: '{company}: order {order} received, total {total}.', email_subject: '', email_template: '', updated_at: '2026-10-27T00:00:00Z' };
const NOTIFICATION = { id: 'n1', event: 'order_placed', channel: 'sms', restaurant_id: 'r1', to_address: '919900011111', subject: null,
  body: 'Fresh Supply: order ORD-1 received', status: 'skipped', provider: 'none', error: 'SMS_PROVIDER is not set (none): message skipped', attempts: 1, created_at: '2026-10-27T05:00:00Z', restaurants: { name: 'Spice Hut' } };
const TICKET = { id: 't1', ticket_number: 'TKT-1000', restaurant_id: 'r1', subject: 'Wrong grade of tomato', status: 'open', priority: 'normal', assigned_to: null,
  created_at: '2026-10-27T05:00:00Z', last_message_at: '2026-10-27T05:00:00Z', restaurants: { name: 'Spice Hut', phone: '9900011111' } };
const TICKET_MESSAGE = { id: 'm1', ticket_id: 't1', author_id: 'u-r', is_staff: false, body: 'They were grade B', created_at: '2026-10-27T05:00:00Z' };
const ARTICLE = { id: 'h1', slug: 'who-can-order', title: 'Who can order?', body: 'Any food business.\n\nHome chefs too.', audience: 'public', sort_order: 10, is_published: true, updated_at: '2026-10-27T00:00:00Z' };
const CHANNELS = { phone: '+91 99000 00001', whatsapp: '919900000001', email: 'help@fresh.in', name: 'Fresh Supply' };

test('admin: Settings → Notifications edits a template with a live preview and the log shows skipped messages with Retry + Send now', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { notification_settings: [NOTIFY_SETTING], notifications: [NOTIFICATION] },
    rpc: { ...ADMIN_RPC, retry_notification: () => null, 'send-notifications': () => ({ ok: true, reminders_queued: 0, claimed: 1, sent: 0, failed: 0, skipped: 1 }) },
  });
  location.hash = '#notifications';
  document.defaultView.location.hash = '#notifications';   // tabs are same-page anchors: keep jsdom's real hash in step so a tab click fires no hashchange
  await new Promise((r) => setTimeout(r, 0));              // let jsdom's own hashchange pass before the router exists
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-edit="order_placed|"]'));   // key = "event|sector"; the default row has no sector
  assert.match(document.body.textContent, /Order placed/);
  document.querySelector('[data-edit="order_placed|"]').click();
  const form = await waitFor(() => document.querySelector('#tpl'));
  assert.match(document.querySelector('#sms-preview').textContent, /Fresh Supply: order ORD-1042 received, total ₹4,250.00/);
  form.elements.sms_template.value = 'Order {order} {oops}';
  form.elements.sms_template.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.match(document.querySelector('#sms-preview').textContent, /unknown: \{oops\}/);
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'notification_settings'));
  const saved = fake.calls.find((c) => c.table === 'notification_settings');
  assert.equal(saved.payload.sms_template, 'Order {order} {oops}');
  assert.deepEqual(saved.filters, [['event', 'order_placed'], ['sector_code', null, 'is']]);   // updates the default row, not by a non-existent id
  // The log tab
  document.querySelector('[data-tab="log"]').click();
  await waitFor(() => document.querySelector('[data-retry="n1"]'));
  assert.match(document.body.textContent, /SMS_PROVIDER is not set/);
  document.querySelector('[data-retry="n1"]').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'retry_notification'));
  document.querySelector('#send-now').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'function' && c.name === 'send-notifications'));
  assert.equal(fake.calls.find((c) => c.name === 'send-notifications').body.limit, 100);
});

test('admin: Support channels saves the WhatsApp number as digits and the master switch', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { notification_settings: [], notifications: [], company_settings: [{ ...COMPANY, support_phone: '', support_whatsapp: '', support_email: '', sms_from_label: 'Fresh Supply', notify_customers: true }] },
    rpc: ADMIN_RPC,
  });
  location.hash = '#notifications';
  document.defaultView.location.hash = '#notifications';
  await new Promise((r) => setTimeout(r, 0));
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-tab="channels"]'));
  document.querySelector('[data-tab="channels"]').click();
  const form = await waitFor(() => document.querySelector('#channels-form'));
  form.elements.support_whatsapp.value = '+91 99000 00001';
  form.elements.support_phone.value = '99000 00001';
  form.elements.notify_customers.checked = false;
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'company_settings'));
  const saved = fake.calls.find((c) => c.table === 'company_settings').payload;
  assert.equal(saved.support_whatsapp, '919900000001'); assert.equal(saved.notify_customers, false);
});

test('admin: Orders → Tickets lists tickets with Call / WhatsApp, a reply calls reply_ticket and "update without replying" calls set_ticket', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { support_tickets: [TICKET], ticket_messages: [TICKET_MESSAGE], restaurants: [RESTAURANT] },
    rpc: { ...ADMIN_RPC, reply_ticket: () => null, set_ticket: () => null },
  });
  location.hash = '#tickets';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-open="t1"]'));
  assert.match(document.querySelector('a[href^="https://wa.me/919900011111"]').href, /TKT-1000/);
  document.querySelector('[data-open="t1"]').click();
  const form = await waitFor(() => document.querySelector('#reply'));
  assert.match(document.querySelector('.modal, [role="dialog"]')?.textContent ?? document.body.textContent, /They were grade B/);
  form.elements.body.value = 'Sorry — credit note on its way';
  form.elements.priority.value = 'high';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'reply_ticket'));
  assert.equal(fake.calls.find((c) => c.name === 'reply_ticket').args.p_body, 'Sorry — credit note on its way');
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'set_ticket'));
  assert.equal(fake.calls.find((c) => c.name === 'set_ticket').args.p_priority, 'high');
});

test('admin: Settings → Help centre creates an article (slug from the title) and the website FAQ reads public ones', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { help_articles: [ARTICLE] }, rpc: ADMIN_RPC,
  });
  location.hash = '#help-centre';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-edit="h1"]'));
  document.querySelector('#new-article').click();
  const form = await waitFor(() => document.querySelector('#article'));
  form.elements.title.value = 'How do I pay?';
  form.elements.title.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.equal(form.elements.slug.value, 'how-do-i-pay');
  form.elements.body.value = 'Cash on delivery or credit.';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'insert' && c.table === 'help_articles'));
  const row = fake.calls.find((c) => c.table === 'help_articles').payload;
  assert.equal(row.slug, 'how-do-i-pay'); assert.equal(row.audience, 'customer'); assert.equal(row.sort_order, 20);
});

test('landing: the FAQ and footer contact come from help_articles (public) and support_channels()', async () => {
  const body = '<div id="categories"></div><div id="featured"></div><div class="faq" id="faq-list"><details><summary>Static</summary></details></div><div id="footer-contact"><h4>Contact</h4></div>';
  const { document } = setup({ session: null, tables: { products: PRODUCTS, help_articles: [ARTICLE, { ...ARTICLE, id: 'h2', slug: 'drv', title: 'Driver only', audience: 'driver' }] },
    rpc: { support_channels: () => CHANNELS }, body });
  await importFresh('web/js/pages/landing.js');
  await waitFor(() => /Who can order\?/.test(document.querySelector('#faq-list').textContent));
  assert.doesNotMatch(document.querySelector('#faq-list').textContent, /Driver only|Static/);
  assert.equal(document.querySelectorAll('#faq-list details p').length, 2, 'blank line → two paragraphs');
  await waitFor(() => /help@fresh.in/.test(document.querySelector('#footer-contact').textContent));
  assert.match(document.querySelector('#footer-contact a[href^="https://wa.me/"]').href, /919900000001/);
});

test('restaurant: Help shows contact buttons, raises a ticket about an order, and replies on it', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, orders: [{ ...ORDER, status: 'delivered' }], support_tickets: [TICKET], ticket_messages: [TICKET_MESSAGE], help_articles: [ARTICLE] },
    rpc: { my_order_terms: () => TERMS, support_channels: () => CHANNELS, open_ticket: () => ({ id: 't2', ticket_number: 'TKT-1001' }), reply_ticket: () => null, set_ticket: () => null },
  });
  location.hash = '#help';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('#new-ticket'));
  assert.match(document.querySelector('#contact-card a[href^="tel:"]').href, /tel:\+919900000001/);
  assert.match(document.querySelector('#contact-card a[href^="https://wa.me/"]').href, /919900000001/);
  assert.match(document.body.textContent, /Who can order\?/);
  document.querySelector('#new-ticket').click();
  const form = await waitFor(() => document.querySelector('#new'));
  form.elements.subject.value = 'Invoice query'; form.elements.body.value = 'GST line looks wrong'; form.elements.orderId.value = ORDER.id;
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'open_ticket'));
  const args = fake.calls.find((c) => c.name === 'open_ticket').args;
  assert.equal(args.p_subject, 'Invoice query'); assert.equal(args.p_order_id, ORDER.id); assert.equal(args.p_restaurant_id, null);
  await waitFor(() => document.querySelector('[data-ticket="t1"]'));
  document.querySelector('[data-ticket="t1"]').click();
  const reply = await waitFor(() => document.querySelector('#reply'));
  reply.elements.body.value = 'Thanks';
  reply.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'reply_ticket'));
  document.querySelector('#close-ticket').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'set_ticket'));
  assert.equal(fake.calls.find((c) => c.name === 'set_ticket').args.p_status, 'closed');
});

test('restaurant: Account → "Use my location" stores the pin (update_my_location); the driver gets a pin link (delivery_pins)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [{ ...RESTAURANT }], products: PRODUCTS },
    rpc: { my_order_terms: () => TERMS, update_my_location: () => null },
  });
  Object.defineProperty(document.defaultView.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (ok) => ok({ coords: { latitude: 17.68681234, longitude: 83.21851234 } }) } });
  location.hash = '#account';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('#use-location'));
  document.querySelector('#use-location').click();
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'update_my_location'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'update_my_location').args, { p_lat: 17.686812, p_lng: 83.218512 });
  await waitFor(() => /Pinned at 17.68681/.test(document.querySelector('#pin-status').textContent));

  const d = setup({
    session: { user: { id: 'u-d', email: 'd@x.com' } }, profile: DRIVER,
    tables: { orders: [{ ...ORDER, status: 'packed', assigned_to: 'u-d', contact_phone: '9900011111' }] },
    rpc: { delivery_pins: () => [{ order_id: ORDER.id, lat: 17.686812, lng: 83.218512 }] },
  });
  await importFresh('web/js/pages/delivery/main.js');
  await waitFor(() => d.document.querySelector('[data-start]'));
  assert.equal(d.document.querySelector('a[href^="https://www.google.com/maps"]').href, 'https://www.google.com/maps?q=17.686812,83.218512');
  assert.match(d.document.querySelector('a[href^="https://wa.me/"]').href, /ORD-/);
});

// ---------- Reports & dashboard (migration 019) ------------------------------
const CITY2 = { id: 'city-hyd', name: 'Hyderabad', state_code: '36', is_active: true, sort_order: 20 };
const STATS = { orders_today: 7, revenue_today: 12500, revenue_7d: 80000, pending_restaurants: 0, open_orders_by_status: {}, top_products_30d: [],
  receivables_open: 100, receivables_overdue: 0, open_tickets: 2, daily_14d: Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 10).padStart(2, '0')}`, orders: i, revenue: i * 100 })) };
const PAGE = { slug: 'about', title: 'About us', body: 'We supply kitchens.\n\n## Where\n\nVisakhapatnam.', is_published: true, show_in_footer: true, sort_order: 10, updated_at: '2026-10-27T00:00:00Z' };

test('admin: Reports shows the sales table with totals, regroups, switches to the trend, and exports CSV (reports:export)', async () => {
  const calls = [];
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { cities: [CITY, CITY2] },
    rpc: { ...ADMIN_RPC,
      sales_report: (a) => { calls.push(a); return a.p_group_by === 'product'
        ? [{ key: 'p1', label: 'Tomato', orders: 3, quantity: 40, subtotal: 1280, tax: 0, delivery_fee: 0, total: 1280, cancelled: 0 }]
        : [{ key: '2026-10-26', label: '26 Oct 2026', orders: 2, quantity: null, subtotal: 1000, tax: 50, delivery_fee: 0, total: 1050, cancelled: 1 },
           { key: '2026-10-27', label: '27 Oct 2026', orders: 1, quantity: null, subtotal: 500, tax: 0, delivery_fee: 49, total: 549, cancelled: 0 }]; },
      receivables_trend: () => [{ week_end: '2026-10-19', invoiced: 1000, collected: 400, open: 600, overdue: 100 }, { week_end: '2026-10-26', invoiced: 500, collected: 600, open: 500, overdue: 0 }] },
  });
  location.hash = '#reports';
  document.defaultView.location.hash = '#reports';
  await new Promise((r) => setTimeout(r, 0));
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('tfoot'));
  assert.match(document.querySelector('tfoot').textContent.replace(/\s/g, ''), /Total3.*₹1,599\.00.*1/);
  assert.equal(calls[0].p_group_by, 'day'); assert.equal(calls[0].p_city_id, null);
  const group = document.querySelector('[data-f="groupBy"]'); group.value = 'product';
  group.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => /Quantity/.test(document.querySelector('thead').textContent));
  assert.match(document.body.textContent, /Tomato/);
  const city = document.querySelector('[data-f="cityId"]'); city.value = 'city-hyd';
  city.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => calls.some((c) => c.p_city_id === 'city-hyd'));
  // CSV export goes through a blob URL; stub it and check the file name.
  const win = document.defaultView; let downloaded = null;
  win.URL.createObjectURL = () => 'blob:x'; win.URL.revokeObjectURL = () => {};
  const realClick = win.HTMLAnchorElement.prototype.click;
  win.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
  document.querySelector('#export').click();
  win.HTMLAnchorElement.prototype.click = realClick;
  assert.match(downloaded, /^sales-product-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  document.querySelector('[data-tab="trend"]').click();
  await waitFor(() => document.querySelector('.bars'));
  assert.equal(document.querySelectorAll('.bar-col').length, 2);
  assert.match(document.body.textContent, /Open now ₹500\.00/);
});

test('admin: a picker has no Reports menu and sees "No access" on #reports', async () => {
  const { document, location } = setup({ session: { user: { id: 'u-pick', email: 'p@x.com' } }, profile: PICKER, rpc: ADMIN_RPC });
  location.hash = '#reports';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => /No access/.test(document.querySelector('#view').textContent));
  assert.equal([...document.querySelectorAll('.nav-link')].some((a) => a.textContent.includes('Reports')), false);
});

test('admin: the dashboard shows the 14-day chart and open tickets, and the city filter re-queries the stats', async () => {
  const seen = [];
  const { document } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN, tables: { cities: [CITY, CITY2] },
    rpc: { ...ADMIN_RPC, admin_dashboard_stats: (a) => { seen.push(a?.p_city_id ?? null); return STATS; } },
  });
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('#daily-chart'));
  assert.equal(document.querySelectorAll('#daily-chart .bar-col').length, 14);
  assert.match(document.body.textContent, /Open tickets\s*2/);
  const sel = document.querySelector('#dash-city'); sel.value = 'city-hyd';
  sel.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => seen.includes('city-hyd'));
});

test('admin: Settings → Website saves the SEO title and creates a page (slug from the title, upsert)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { content_pages: [PAGE], company_settings: [{ ...COMPANY, seo_title: 'Old', seo_description: 'Old d' }] }, rpc: ADMIN_RPC,
  });
  location.hash = '#website';
  await importFresh('web/js/pages/admin/main.js');
  const seo = await waitFor(() => document.querySelector('#seo-form'));
  seo.elements.seo_title.value = 'Fresh Supply — wholesale for kitchens';
  seo.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'update' && c.table === 'company_settings'));
  assert.equal(fake.calls.find((c) => c.table === 'company_settings').payload.seo_title, 'Fresh Supply — wholesale for kitchens');
  assert.match(document.body.textContent, /page\.html\?slug=about/);
  document.querySelector('#new-page').click();
  const form = await waitFor(() => document.querySelector('#page'));
  form.elements.title.value = 'Delivery areas';
  form.elements.title.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.equal(form.elements.slug.value, 'delivery-areas');
  form.elements.body.value = 'We deliver across Vizag.';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'upsert' && c.table === 'content_pages'));
  const row = fake.calls.find((c) => c.table === 'content_pages').payload;
  assert.equal(row.slug, 'delivery-areas'); assert.equal(row.show_in_footer, true); assert.equal(row.sort_order, 20);
});

test('public: page.html renders a content page from ?slug and the footer lists the published pages', async () => {
  const body = '<main id="page"></main><footer><p id="footer-company"></p><div id="footer-pages"><h4>Company</h4></div><div id="footer-contact"></div></footer>';
  const { document, location } = setup({ session: null, tables: { content_pages: [PAGE, { ...PAGE, slug: 'draft', title: 'Draft', is_published: false }] },
    rpc: { support_channels: () => ({ ...CHANNELS, address: '12 Beach Rd', fssai: '123', gstin: '37X' }) }, body });
  location.search = '?slug=about';
  await importFresh('web/js/pages/page.js');
  await waitFor(() => document.querySelector('#page h1'));
  assert.equal(document.querySelector('#page h1').textContent, 'About us');
  assert.equal(document.querySelector('#page h2').textContent, 'Where');
  assert.equal(document.title, 'About us — Fresh Supply');
  await waitFor(() => document.querySelector('#footer-pages a'));
  assert.deepEqual([...document.querySelectorAll('#footer-pages a')].map((a) => a.textContent), ['About us'], 'drafts are not linked');
  assert.match(document.querySelector('#footer-company').textContent, /12 Beach Rd.*FSSAI Lic\. No\. 123/);
});

test('restaurant: Account uploads an FSSAI document into the customer folder and records it (set_customer_document)', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [{ ...RESTAURANT, status: 'pending' }], products: PRODUCTS },
    rpc: { my_order_terms: () => TERMS, set_customer_document: () => null },
  });
  location.hash = '#account';
  await importFresh('web/js/pages/restaurant/main.js');
  const input = await waitFor(() => document.querySelector('[data-upload-doc="fssai"]'));
  assert.match(document.body.textContent, /Upload your FSSAI licence so we can approve your account faster/);
  const file = new document.defaultView.File(['%PDF-1.4'], 'licence.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'set_customer_document'));
  const up = fake.calls.find((c) => c.type === 'upload');
  assert.equal(up.bucket, 'customer-documents'); assert.match(up.path, /^r1\/fssai-\d+\.pdf$/);
  const args = fake.calls.find((c) => c.name === 'set_customer_document').args;
  assert.equal(args.p_restaurant_id, 'r1'); assert.equal(args.p_kind, 'fssai'); assert.equal(args.p_path, up.path);
  await waitFor(() => /on file/.test(document.querySelector('#documents').textContent));
});

// ---------- Customer organisation (migration 020) ------------------------------
const OUTLETS = [
  { id: 'out-1', restaurant_id: 'r1', name: 'Main kitchen', address: '12 MG Road', pincode: '530001', city_id: 'city-vz', warehouse_id: 'wh-1', delivers: true, default_slot: 'morning', is_primary: true, is_active: true, lat: null, lng: null, phone: '999' },
  { id: 'out-2', restaurant_id: 'r1', name: 'Officers mess', address: 'Mess Road', pincode: '530001', city_id: 'city-vz', warehouse_id: 'wh-1', delivers: true, default_slot: 'evening', is_primary: false, is_active: true, lat: 17.7, lng: 83.3, phone: null },
];
const ORG_TERMS = { ...TERMS, min_order_value: 0, customer_role: 'owner', outlet_scope: null, needs_order_approval: true, orders_held_for_me: false, can_approve: true, pending_approvals: 1, outlets: OUTLETS };
const HELD = { ...ORDER, id: 'o-held', order_number: 'ORD-77', status: 'placed', approval_status: 'pending', outlet_id: 'out-2', notes: 'for the mess' };

test('restaurant (owner): the cart offers the outlets, pre-fills the outlet slot and sends p_outlet_id', async () => {
  const { document, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, orders: [] },
    rpc: { my_restaurant_id: () => 'r1', place_order: () => ({ id: 'o9', order_number: 'ORD-1009', total_amount: 160, approval_status: 'not_required' }), my_order_terms: () => ORG_TERMS },
  });
  localStorage.clear();
  const cart = await import('../web/js/pages/restaurant/cart.js'); cart._reset();
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-add="p1"]'));
  document.querySelector('[data-add="p1"]').click();
  document.querySelector('#open-cart').click();
  const outlet = await waitFor(() => document.querySelector('#outlet'));
  assert.equal(outlet.options.length, 2);
  outlet.value = 'out-2'; outlet.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => document.querySelector('#slot').value === 'evening');
  document.querySelector('#place:not([disabled])').click();
  await waitFor(() => fake.calls.some((c) => c.name === 'place_order'));
  const call = fake.calls.find((c) => c.name === 'place_order');
  assert.equal(call.args.p_outlet_id, 'out-2'); assert.equal(call.args.p_delivery_slot, 'evening');
  // Approvals tab shows with the pending count for an approver / owner.
  const tab = document.querySelector('[data-href="#approvals"]');
  assert.equal(tab.hidden, false); assert.equal(tab.querySelector('.nav-badge').textContent, '1');
});

test('restaurant (owner): Approvals lists held orders and approves / rejects through approve_order', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, orders: [HELD, { ...ORDER, approval_status: 'not_required' }] },
    rpc: { my_restaurant_id: () => 'r1', my_order_terms: () => ORG_TERMS, approve_order: () => null },
  });
  location.hash = '#approvals';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('[data-approve="o-held"]'));
  assert.equal(document.querySelectorAll('[data-order]').length, 1, 'only the held order');
  assert.match(document.body.textContent, /Officers mess/);
  document.querySelector('[data-note="o-held"]').value = 'looks right';
  document.querySelector('[data-approve="o-held"]').click();
  await waitFor(() => fake.calls.some((c) => c.name === 'approve_order'));
  assert.deepEqual(fake.calls.find((c) => c.name === 'approve_order').args, { p_order_id: 'o-held', p_approve: true, p_note: 'looks right' });
});

test('restaurant (outlet manager): the Approvals tab is hidden from the badge, the cart says orders are held, business details are read-only', async () => {
  const { document, location } = setup({
    session: { user: { id: 'u-m', email: 'm@x.com' } }, profile: { id: 'u-m', role: 'restaurant', full_name: 'Mess Manager', is_active: true },
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, orders: [], outlets: [OUTLETS[1]], cities: [CITY] },
    rpc: { my_restaurant_id: () => 'r1', my_order_terms: () => ({ ...ORG_TERMS, customer_role: 'outlet_manager', outlet_scope: 'out-2', orders_held_for_me: true, can_approve: false, pending_approvals: 0, outlets: [OUTLETS[1]] }),
      my_customer_users: () => [{ user_id: 'u-r', full_name: 'Ravi', role: 'owner', outlet_id: null, is_active: true, created_at: '2026-10-01T00:00:00Z' }] },
  });
  localStorage.clear();
  const cart = await import('../web/js/pages/restaurant/cart.js'); cart._reset();
  location.hash = '#account';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('#team'));
  assert.equal(document.querySelector('#account-form [name="name"]').disabled, true, 'members cannot edit the business');
  assert.equal(document.querySelector('#invite-member'), null, 'only the owner invites');
  assert.match(document.body.textContent, /Spice Hut/); // restaurant resolved through my_restaurant_id
  assert.equal(document.querySelector('[data-href="#approvals"]').querySelector('.nav-badge').hidden, true);
  document.querySelector('#open-cart').click();
  await waitFor(() => /go to the account owner/.test(document.body.textContent) || document.querySelector('.drawer'));
  // With one outlet in scope there is no outlet picker.
  assert.equal(document.querySelector('#outlet'), null);
});

test('restaurant (owner): Account → Team invites a member through the customer-users function; Outlets saves through save_outlet', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-r', email: 'r@x.com' } }, profile: RESTAURANT_USER,
    tables: { restaurants: [RESTAURANT], products: PRODUCTS, orders: [], outlets: OUTLETS, cities: [CITY] },
    rpc: { my_restaurant_id: () => 'r1', my_order_terms: () => ORG_TERMS, save_outlet: () => 'out-3',
      my_customer_users: () => [{ user_id: 'u-r', full_name: 'Ravi', role: 'owner', outlet_id: null, is_active: true, created_at: '2026-10-01T00:00:00Z' }],
      'customer-users': (b) => ({ ok: true, invited: true, email: b.email }) },
  });
  location.hash = '#account';
  await importFresh('web/js/pages/restaurant/main.js');
  await waitFor(() => document.querySelector('#invite-member'));
  document.querySelector('#invite-member').click();
  const form = await waitFor(() => document.querySelector('#member-form'));
  form.elements.fullName.value = 'Approving Officer'; form.elements.email.value = 'officer@unit.in'; form.elements.role.value = 'approver';
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'function' && c.name === 'customer-users'));
  const body = fake.calls.find((c) => c.name === 'customer-users').body;
  assert.equal(body.role, 'approver'); assert.equal(body.restaurant_id, 'r1'); assert.equal(body.outlet_id, null);
  await waitFor(() => !document.querySelector('#member-form'));
  document.querySelector('#add-outlet').click();
  const of = await waitFor(() => document.querySelector('#outlet-form'));
  of.elements.name.value = 'Branch 2'; of.elements.address.value = 'Beach Road'; of.elements.pincode.value = '530002'; of.elements.defaultSlot.value = 'afternoon';
  of.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fake.calls.some((c) => c.type === 'rpc' && c.name === 'save_outlet'));
  const args = fake.calls.find((c) => c.name === 'save_outlet').args;
  assert.equal(args.p_name, 'Branch 2'); assert.equal(args.p_pincode, '530002'); assert.equal(args.p_default_slot, 'afternoon'); assert.equal(args.p_id, null);
});

test('admin: orders can be filtered to "awaiting customer approval"; a held order shows the notice and the outlet', async () => {
  const { document, location, fake } = setup({
    session: { user: { id: 'u-admin', email: 'a@x.com' } }, profile: ADMIN,
    tables: { orders: [{ ...HELD, outlets: { name: 'Officers mess' } }, ORDER], order_status_history: [] },
    rpc: ADMIN_RPC,
  });
  location.hash = '#orders';
  await importFresh('web/js/pages/admin/main.js');
  await waitFor(() => document.querySelector('[data-order="o-held"]'));
  assert.match(document.querySelector('[data-order="o-held"]').textContent, /Awaiting approval/);
  const sel = document.querySelector('[data-filter="approvalStatus"]'); sel.value = 'pending';
  sel.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await waitFor(() => document.querySelectorAll('[data-order]').length === 1);
  document.querySelector('[data-order="o-held"]').click();
  await waitFor(() => /Awaiting the customer's approval/.test(document.body.textContent));
  assert.match(document.body.textContent, /Officers mess/);
});

test('login: a sector page link pre-selects the sector on the register form', async () => {
  const { document, location } = setup({ session: null, body: '<div id="auth-root" data-role="restaurant"></div>' });
  location.hash = '#register&sector=defence';
  await importFresh('web/js/pages/login.js');
  const select = await waitFor(() => document.querySelector('[name="sectorCode"]'));
  assert.equal(select.value, 'defence');
});

test('landing: "Who we serve" tiles come from live sectors with their pages and a register link per sector', async () => {
  const body = '<div id="categories"></div><div id="featured"></div><div class="faq" id="faq-list"></div><section><div id="sector-tiles"></div></section><div id="footer-pages"></div><div id="footer-contact"></div><p id="footer-company"></p>';
  const { document } = setup({ session: null, tables: { products: PRODUCTS, content_pages: [{ slug: 'sector-defence', title: 'For messes', body: 'x', is_published: true, show_in_footer: false, sort_order: 1 }] }, rpc: { support_channels: () => CHANNELS }, body });
  await importFresh('web/js/pages/landing.js');
  await waitFor(() => document.querySelectorAll('#sector-tiles article').length > 0);
  const tiles = [...document.querySelectorAll('#sector-tiles article')];
  assert.equal(tiles.length, SECTORS.filter((s) => s.is_active && s.can_self_register).length);
  const defence = tiles.find((t) => /defence|cantonment/i.test(t.textContent));
  assert.ok(defence.querySelector('a[href="page.html?slug=sector-defence"]'), 'Learn more link when the page exists');
  assert.ok(defence.querySelector('a[href="restaurant/login.html#register&sector=defence"]'));
});
