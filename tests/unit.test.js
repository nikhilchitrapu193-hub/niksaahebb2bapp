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
  assert.equal(visibleNav(superAdmin).length, 9, 'every module with a nav entry (pricing added in 009)');
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

// ---------- Pricing engine (migration 009) -----------------------------------
// The four cases below are the SAME inputs as security_test.sql T30a–T30e; the
// SQL function and this JS one must give these numbers.
const pricing = await import('../web/js/core/pricing.js');

test('computePrice: cost + per-kg costs + fee + wastage + markup, rounded to ₹0.50 (= SQL T30a)', () => {
  const r = pricing.computePrice({ pricing_mode: 'rule', cost_method: 'quote', supplier_quote: 24, weight_kg: 1, transport_per_kg: 1.5, handling_per_kg: 0.5,
    packing_per_unit: 0, market_fee_pct: 2, other_cost_pct: 0, yield_pct: 100, wastage_pct: 8, markup_pct: 15, min_markup_pct: 8,
    rounding_step: 0.5, round_mode: 'nearest', benchmark_price: 32, benchmark_cap_pct: 10, benchmark_age_days: 1 });
  assert.equal(r.landed_cost, 28.83);
  assert.equal(r.suggested_price, 33);
  assert.equal(r.margin_amount, 4.17);
  assert.equal(r.markup_effective_pct, 14.48);
  assert.equal(r.margin_pct, 12.64);
  assert.deepEqual(r.flags, []);
});

test('computePrice: yield and wastage, round up to ₹5, stale benchmark and cost move flagged (= SQL T30b)', () => {
  const r = pricing.computePrice({ pricing_mode: 'rule', cost_method: 'weighted_avg_30d', avg_cost_30d: 100, latest_cost: 120, weight_kg: 1, yield_pct: 70,
    wastage_pct: 3, markup_pct: 10, min_markup_pct: 5, rounding_step: 5, round_mode: 'up', benchmark_price: 150, benchmark_age_days: 9 });
  assert.equal(r.landed_cost, 147.28);
  assert.equal(r.suggested_price, 165);
  assert.equal(r.margin_amount, 17.72);
  assert.deepEqual(r.flags, ['stale_benchmark', 'cost_moved']);
});

test('computePrice: manual price below cost, benchmark cap, no cost (= SQL T30c–e)', () => {
  const manual = pricing.computePrice({ pricing_mode: 'manual', manual_price: 20, latest_cost: 25, cost_method: 'latest', rounding_step: 1, round_mode: 'nearest' });
  assert.equal(manual.suggested_price, 20);
  assert.deepEqual(manual.flags, ['manual', 'below_cost']);

  const capped = pricing.computePrice({ pricing_mode: 'rule', cost_method: 'quote', supplier_quote: 100, markup_pct: 50, benchmark_price: 120, benchmark_cap_pct: 10,
    rounding_step: 1, round_mode: 'nearest', min_markup_pct: 40 });
  assert.equal(capped.suggested_price, 132);
  assert.equal(capped.capped, true);
  assert.deepEqual(capped.flags, ['capped', 'below_min_markup']);

  const none = pricing.computePrice({ pricing_mode: 'rule', cost_method: 'latest', markup_pct: 10 });
  assert.equal(none.suggested_price, null);
  assert.deepEqual(none.flags, ['no_cost']);

  const eggs = pricing.computePrice({ pricing_mode: 'fixed_over_benchmark', fixed_margin_amount: 9, benchmark_price: 180, rounding_step: 1, round_mode: 'nearest', latest_cost: 170, cost_method: 'latest' });
  assert.equal(eggs.suggested_price, 189, 'NECC + ₹9 per tray');
  assert.deepEqual(pricing.computePrice({ pricing_mode: 'fixed_over_benchmark', fixed_margin_amount: 9, latest_cost: 170, cost_method: 'latest' }).flags, ['no_benchmark']);
});

test('roundPrice, weightKg, marginOf, sparklinePath', () => {
  assert.equal(pricing.roundPrice(33.15, 0.5, 'nearest'), 33);
  assert.equal(pricing.roundPrice(33.26, 0.5, 'nearest'), 33.5);
  assert.equal(pricing.roundPrice(162.0029, 5, 'up'), 165);
  assert.equal(pricing.roundPrice(165, 5, 'up'), 165, 'already on the step stays');
  assert.equal(pricing.roundPrice(12.345, 0, 'nearest'), 12.35, 'no step = 2 decimals');
  assert.equal(pricing.weightKg({ pack_size: 15, pack_unit: 'l' }), 15);
  assert.equal(pricing.weightKg({ pack_size: 500, pack_unit: 'g' }), 0.5);
  assert.equal(pricing.weightKg({ pack_size: 30, pack_unit: 'pc' }), null);
  assert.deepEqual(pricing.marginOf(24, 21.74), { amount: 2.26, pct: 9.42, markupPct: 10.4 });
  assert.deepEqual(pricing.marginOf(24, null), { amount: null, pct: null, markupPct: null });
  assert.equal(pricing.sparklinePath([1], 100, 20), '', 'one point draws nothing');
  assert.match(pricing.sparklinePath([10, 20, 15], 100, 20), /^M0,19 L50,1 L100,10$/);
});

const { parseCsv } = await import('../web/js/core/csv.js');
const { csvToBenchmarks } = await import('../web/js/pages/admin/benchmarks.js');

test('parseCsv: quoted cells, doubled quotes, CRLF, BOM, blank lines', () => {
  const parsed = parseCsv('﻿SKU,Price,Market\r\nVEG-001,24.5,"MVP Colony, gate 2"\r\n"X-""1""",10,\r\n\r\n');
  assert.deepEqual(parsed.headers, ['sku', 'price', 'market']);
  assert.deepEqual(parsed.rows, [{ sku: 'VEG-001', price: '24.5', market: 'MVP Colony, gate 2' }, { sku: 'X-"1"', price: '10', market: '' }]);
  assert.deepEqual(parseCsv(''), { headers: [], rows: [] });
});

test('csvToBenchmarks: resolves SKU and source, fills defaults, reports bad lines by number', () => {
  const parsed = parseCsv('sku,price,source,date\nVEG-001,24,rythu_bazaar,2026-10-15\nveg-002,22,,\nNOPE,5,,\nVEG-001,abc,,\nVEG-001,30,necc,15/10/2026');
  const { rows, problems } = csvToBenchmarks(parsed, [{ id: 'p1', sku: 'VEG-001' }, { id: 'p2', sku: 'VEG-002' }],
    [{ id: 's1', code: 'rythu_bazaar' }, { id: 's2', code: 'necc' }], { source_id: 's2', price_date: '2026-10-14' });
  assert.deepEqual(rows, [
    { source_id: 's1', product_id: 'p1', price_date: '2026-10-15', price: 24, market: null },
    { source_id: 's2', product_id: 'p2', price_date: '2026-10-14', price: 22, market: null },
  ]);
  assert.deepEqual(problems, ['line 4: unknown SKU "NOPE"', 'line 5: price "abc" is not a number', 'line 6: date "15/10/2026" must be YYYY-MM-DD']);
});

const { ruleInForce } = await import('../web/js/pages/admin/pricing-rules.js');
const { displayPrice } = await import('../web/js/pages/restaurant/catalogue.js');

test('ruleInForce picks the newest started, unexpired row for the category; displayPrice honours the GST setting', () => {
  const rules = [
    { id: 'g', category_id: null, effective_from: '2026-01-01', effective_to: null, markup_pct: 10 },
    { id: 'v1', category_id: 'c1', effective_from: '2026-01-01', effective_to: '2026-10-31', markup_pct: 15 },
    { id: 'v2', category_id: 'c1', effective_from: '2026-11-01', effective_to: null, markup_pct: 14 },
  ];
  assert.equal(ruleInForce(rules, 'c1', '2026-10-15').id, 'v1');
  assert.equal(ruleInForce(rules, 'c1', '2026-11-01').id, 'v2');
  assert.equal(ruleInForce(rules, 'c2', '2026-10-15'), null, 'no own rule → caller falls back to global');
  assert.equal(ruleInForce(rules, null, '2026-10-15').id, 'g');
  assert.deepEqual(displayPrice({ price: 100, gst_rate: 5 }, { show_prices_incl_gst: true }), { amount: 105, inclGst: true });
  assert.deepEqual(displayPrice({ price: 100, gst_rate: 5 }, null), { amount: 100, inclGst: false });
});

// ---------- Catalogue + (migration 010) -------------------------------------
const cat = await import('../web/js/core/catalogue.js');
const { csvToProducts, categoryByName } = await import('../web/js/core/csv-import.js');
const { listPrice } = await import('../web/js/pages/admin/price-lists.js');

const CATS = [
  { id: 'veg', name: 'Vegetables', parent_id: null, sort_order: 10 },
  { id: 'leafy', name: 'Leafy greens', parent_id: 'veg', sort_order: 11 },
  { id: 'root', name: 'Root vegetables', parent_id: 'veg', sort_order: 12 },
  { id: 'dairy', name: 'Dairy & Eggs', parent_id: null, sort_order: 30 },
];
const PRODS = [
  { id: 'a', sku: 'VEG-001', name: 'Tomato', price: 32, category_id: 'veg', brand: null, veg_type: 'veg', in_stock: true, stock_qty: 10 },
  { id: 'b', sku: 'VEG-005', name: 'Coriander', price: 60, category_id: 'leafy', brand: 'Farm', veg_type: 'veg', in_stock: true, stock_qty: 0 },
  { id: 'c', sku: 'DAI-005', name: 'Eggs', price: 195, category_id: 'dairy', brand: 'Suguna', veg_type: 'non_veg', in_stock: true, stock_qty: 5 },
  { id: 'r1', sku: 'GRN-001', name: 'Basmati Rice', price: 110, category_id: 'dairy', brand: null, in_stock: true, stock_qty: 5 },
  { id: 'r25', sku: 'GRN-001-25', name: 'Basmati Rice (25 kg bag)', price: 2600, category_id: 'dairy', parent_product_id: 'r1', variant_label: '25 kg bag', in_stock: true, stock_qty: 5 },
];

test('categoryTree / categoryOptions / categoryFamily: two levels in order with paths', () => {
  const tree = cat.categoryTree(CATS);
  assert.deepEqual(tree.map((t) => [t.name, t.children.map((c) => c.name)]), [['Vegetables', ['Leafy greens', 'Root vegetables']], ['Dairy & Eggs', []]]);
  assert.deepEqual(cat.categoryOptions(CATS).map((c) => `${c.depth}:${c.path}`), ['0:Vegetables', '1:Vegetables › Leafy greens', '1:Vegetables › Root vegetables', '0:Dairy & Eggs']);
  assert.deepEqual(cat.categoryFamily(CATS, 'veg'), ['veg', 'leafy', 'root']);
  assert.deepEqual(cat.categoryFamily(CATS, 'leafy'), ['leafy']);
  assert.equal(cat.categoryFamily(CATS, ''), null);
});

test('filterProducts: category family, search, brand, veg type, in-stock and sort', () => {
  const names = (opts) => cat.filterProducts(PRODS, { categories: CATS, ...opts }).map((p) => p.name);
  assert.deepEqual(names({ categoryId: 'veg' }), ['Coriander', 'Tomato'], 'a parent includes its sub-categories, sorted by name');
  assert.deepEqual(names({ categoryId: 'leafy' }), ['Coriander']);
  assert.deepEqual(names({ search: 'farm' }), ['Coriander'], 'search also matches the brand');
  assert.deepEqual(names({ brand: 'Suguna' }), ['Eggs']);
  assert.deepEqual(names({ vegType: 'non_veg' }), ['Eggs']);
  assert.deepEqual(names({ categoryId: 'veg', inStockOnly: true }), ['Tomato']);
  assert.deepEqual(names({ sort: 'price_desc' }).slice(0, 2), ['Basmati Rice (25 kg bag)', 'Eggs']);
  assert.deepEqual(names({ sort: 'price_asc' })[0], 'Tomato');
  assert.deepEqual(cat.brandsOf(PRODS), ['Farm', 'Suguna']);
});

test('groupVariants: one card per main product with its packs; applyPriceList keeps the published price', () => {
  const groups = cat.groupVariants(PRODS);
  assert.equal(groups.length, 4);
  const rice = groups.find((g) => g.main.id === 'r1');
  assert.deepEqual(rice.variants.map((v) => v.id), ['r1', 'r25']);
  assert.deepEqual(cat.groupVariants([PRODS[4]]).map((g) => g.main.id), ['r25'], 'a pack whose main product is filtered out stands alone');
  const priced = cat.applyPriceList(PRODS, [{ product_id: 'a', price: 30.4 }]);
  assert.equal(priced[0].price, 30.4);
  assert.equal(priced[0].list_price, 32);
  assert.equal(priced[1].list_price, undefined);
});

test('csvToProducts: new rows need the basics, existing rows take just the columns given, bad lines are reported', () => {
  const parsed = parseCsv([
    'sku,name,category,price,unit,gst_rate,hsn_code,veg_type,sold_by_weight,parent_sku,variant_label',
    'VEG-009,Spinach,Vegetables › Leafy greens,40,kg,0,0709,veg,yes,,',
    'VEG-001,,,35,,,,,,,',
    'RULE-1,,,99,,,,,,,',
    'NEW-2,No category,,10,kg,,,,,,',
    'NEW-3,Bad gst,Vegetables,10,kg,7,,,,,',
    'GRN-001-5,Rice 5 kg,Dairy & Eggs,560,bag,5,,,no,GRN-001,5 kg bag',
    'BAD-4,Veg?,Vegetables,10,kg,,,maybe,,,',
  ].join('\n'));
  const existing = [{ id: 'a', sku: 'VEG-001', price_source: 'manual' }, { id: 'x', sku: 'RULE-1', price_source: 'rule' }, { id: 'r1', sku: 'GRN-001' }];
  const { rows, problems, created, updated } = csvToProducts(parsed, { categories: CATS, hsnCodes: [{ code: '0709' }], existing });
  assert.equal(created, 2);
  assert.equal(updated, 2);
  assert.deepEqual(rows[0], { sku: 'VEG-009', name: 'Spinach', category_id: 'leafy', price: 40, unit: 'kg', gst_rate: 0, hsn_code: '0709', veg_type: 'veg', sold_by_weight: true });
  assert.deepEqual(rows[1], { sku: 'VEG-001', price: 35, id: 'a' }, 'only the columns present');
  assert.deepEqual(rows[2], { sku: 'RULE-1', id: 'x' }, 'board-priced product keeps its price');
  assert.deepEqual(rows[3], { sku: 'GRN-001-5', name: 'Rice 5 kg', category_id: 'dairy', price: 560, unit: 'bag', gst_rate: 5, sold_by_weight: false, parent_product_id: 'r1', variant_label: '5 kg bag' });
  assert.deepEqual(problems, [
    'line 4 (RULE-1): price skipped — published from the price board',
    'line 5 (NEW-2): new product needs category',
    'line 6 (NEW-3): gst_rate must be 0, 5, 12, 18 or 28',
    'line 8 (BAD-4): veg_type must be veg or non_veg',
  ]);
  assert.equal(categoryByName(CATS, 'vegetables > leafy greens').id, 'leafy');
  assert.equal(categoryByName(CATS, 'Nope'), null);
});

test('listPrice: a fixed item beats the % adjustment (mirror of customer_price)', () => {
  const list = { adjustment_pct: -5 };
  assert.equal(listPrice({ id: 'a', price: 32 }, list, []), 30.4);
  assert.equal(listPrice({ id: 'a', price: 32 }, list, [{ product_id: 'a', price: 30 }]), 30);
  assert.equal(listPrice({ id: 'a', price: 32 }, { adjustment_pct: 0 }, []), 32);
});
