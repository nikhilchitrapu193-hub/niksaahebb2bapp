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
  assert.equal(visibleNav(superAdmin).length, 14, 'every module with a nav entry (pricing 009, procurement 011, fulfilment 012, payments 015, reports 019, knowledge_base 025)');
  // Launch modes (014) hide modules on top of the matrix.
  assert.equal(visibleNav(superAdmin, new Set(['pricing', 'inventory', 'procurement'])).length, 11);
  assert.deepEqual(visibleNav(picker, new Set(['orders'])), [], 'hidden beats granted');
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

// ---------------------------------------------------------------------------
// Procurement helpers (migration 011). suggestedBuy uses the same numbers as
// security_test.sql T45c: demand 20.8, free stock 180, alert level 20, open PO 0.
// ---------------------------------------------------------------------------
import { suggestedBuy, roundToMoq, groupBySupplier, poTotals, outstandingLines, poMessage, whatsappLink } from '../web/js/core/procurement.js';

test('suggestedBuy: demand × cover + alert level − free stock − on order, never negative (mirror of buying_list)', () => {
  const tomato = { demand_qty: 20.8, free_stock: 180, open_po_qty: 0, low_stock_threshold: 20 };
  assert.equal(suggestedBuy(tomato, 1), 0, 'stock already covers the day');
  assert.equal(suggestedBuy(tomato, 10), 48, '20.8 × 10 + 20 − 180 = 48 (T45d)');
  assert.equal(suggestedBuy({ demand_qty: 30, free_stock: 5, open_po_qty: 10, low_stock_threshold: 10 }), 25);
  assert.equal(suggestedBuy({ demand_qty: '12.5', free_stock: null, open_po_qty: undefined, low_stock_threshold: '0' }, 2), 25, 'strings and nulls are tolerated');
  assert.equal(suggestedBuy({ demand_qty: 1, free_stock: 1, open_po_qty: 0, low_stock_threshold: 0.1 }, 1), 0.1, 'rounded to 2 dp');
});

test('roundToMoq: rounds up to a multiple of the MOQ; zero stays zero', () => {
  assert.equal(roundToMoq(48, 50), 50);
  assert.equal(roundToMoq(51, 50), 100);
  assert.equal(roundToMoq(7.2, 1), 8);
  assert.equal(roundToMoq(7.2, null), 8, 'no MOQ behaves like 1');
  assert.equal(roundToMoq(0, 50), 0);
  assert.equal(roundToMoq(-3, 10), 0);
});

test('groupBySupplier: one group per supplier with the rate as line cost; no supplier → null group', () => {
  const groups = groupBySupplier([
    { product_id: 'p1', name: 'Tomato', unit: 'kg', quantity: 50, supplier_id: 's1', supplier_name: 'Farm Co', rate: '21' },
    { product_id: 'p3', name: 'Paneer', unit: 'kg', quantity: 10, supplier_id: 's2', supplier_name: 'Dairy', rate: 290 },
    { product_id: 'p2', name: 'Onion', unit: 'kg', quantity: 20, supplier_id: 's1', supplier_name: 'Farm Co', rate: null },
    { product_id: 'p4', name: 'Ginger', unit: 'kg', quantity: 5, supplier_id: null, supplier_name: null, rate: null },
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0], { supplier_id: 's1', supplier_name: 'Farm Co', lines: [
    { product_id: 'p1', name: 'Tomato', unit: 'kg', quantity: 50, unit_cost: 21 }, { product_id: 'p2', name: 'Onion', unit: 'kg', quantity: 20, unit_cost: null }] });
  assert.equal(groups[1].lines[0].unit_cost, 290);
  assert.equal(groups[2].supplier_id, null);
});

test('poTotals / outstandingLines: value counts only costed lines; outstanding = ordered − received − rejected, floored at 0', () => {
  const items = [
    { qty_ordered: 60, unit_cost: 21, qty_received: 55, qty_rejected: 5 },
    { qty_ordered: 10, unit_cost: 290, qty_received: 0, qty_rejected: 0 },
    { qty_ordered: 4, unit_cost: null, qty_received: 6, qty_rejected: 0 },
  ];
  assert.deepEqual(poTotals(items), { ordered: 74, received: 61, rejected: 5, value: 60 * 21 + 10 * 290 });
  assert.deepEqual(outstandingLines(items).map((i) => i.outstanding), [0, 10, 0]);
  assert.deepEqual(poTotals([]), { ordered: 0, received: 0, rejected: 0, value: 0 });
});

test('poMessage / whatsappLink: readable PO text; 10-digit Indian numbers get the 91 prefix', () => {
  const po = {
    po_number: 'PO-1000', expected_date: '2026-10-16', notes: 'Gate 2', warehouses: { name: 'Vizag main', address: 'Marripalem' },
    purchase_order_items: [{ products: { name: 'Tomato', unit: 'kg' }, qty_ordered: 60, unit_cost: 21 }, { product_id: 'x', qty_ordered: 4, unit_cost: null }],
  };
  const text = poMessage(po, { name: 'Fresh Supply Pvt Ltd', phone: '040-123' });
  assert.match(text, /^Purchase order PO-1000 from Fresh Supply Pvt Ltd\n/);
  assert.match(text, /Deliver by 2026-10-16 to Vizag main, Marripalem/);
  assert.match(text, /• Tomato: 60 kg @ ₹21\.00\n• x: 4/);
  assert.match(text, /Note: Gate 2/);
  assert.match(text, /Call 040-123\.$/);
  assert.equal(whatsappLink('98480 12345', 'hi there'), 'https://wa.me/919848012345?text=hi%20there');
  assert.equal(whatsappLink('+91 98480 12345', 'x'), 'https://wa.me/919848012345?text=x');
  assert.equal(whatsappLink(null, 'x'), 'https://wa.me/?text=x', 'no phone → WhatsApp asks for a contact');
});

// ---------------------------------------------------------------------------
// Fulfilment helpers (migration 012)
// ---------------------------------------------------------------------------
import { tripStops, tripCodToCollect, tripOpenStops, expiryTone, pickListTotals, cashInHand, buildReturns } from '../web/js/core/fulfilment.js';

test('tripStops: orders in stop order; cod-to-collect sums unpaid COD only', () => {
  const trip = { trip_orders: [
    { stop_seq: 2, orders: { id: 'b', payment_method: 'cod', payment_status: 'unpaid', total_amount: 200, status: 'out_for_delivery' } },
    { stop_seq: 1, orders: { id: 'a', payment_method: 'cod', payment_status: 'paid', total_amount: 100, status: 'delivered' } },
    { stop_seq: 3, orders: { id: 'c', payment_method: 'credit', payment_status: 'unpaid', total_amount: 500, status: 'out_for_delivery' } },
  ] };
  assert.deepEqual(tripStops(trip).map((o) => o.id), ['a', 'b', 'c']);
  assert.equal(tripCodToCollect(trip), 200, 'only the unpaid COD order (b) counts');
  assert.equal(tripOpenStops(trip), 2, 'a is delivered, b and c still open');
  assert.equal(tripCodToCollect({}), 0);
});

test('expiryTone: expired / soon / ok', () => {
  assert.equal(expiryTone(-1), 'expired');
  assert.equal(expiryTone(0), 'soon');
  assert.equal(expiryTone(2), 'soon');
  assert.equal(expiryTone(3), 'ok');
  assert.equal(expiryTone(null), 'ok');
});

test('pickListTotals: products, units and short count', () => {
  assert.deepEqual(pickListTotals([
    { pick_qty: 10, short: 0 }, { pick_qty: 5.5, short: 2 }, { pick_qty: 3, short: 0 },
  ]), { products: 3, units: 18.5, shortProducts: 1 });
  assert.deepEqual(pickListTotals([]), { products: 0, units: 0, shortProducts: 0 });
});

test('cashInHand: collected minus settled', () => {
  assert.equal(cashInHand({ collected: 355, settled: 100 }), 255);
  assert.equal(cashInHand({}), 0);
});

test('buildReturns: a return must be >0 and strictly below the billed quantity', () => {
  const items = [{ id: 'i1', product_name: 'Tomato', quantity: 10 }, { id: 'i2', product_name: 'Paneer', quantity: 2 }];
  assert.deepEqual(buildReturns(items, new Map([['i1', '2'], ['i2', '0']])), { lines: [{ order_item_id: 'i1', qty: 2 }] });
  assert.match(buildReturns(items, new Map([['i1', '10']])).error, /refuse the whole order/);
  assert.match(buildReturns(items, new Map([['i1', '-1']])).error, /negative/);
  assert.match(buildReturns(items, new Map([['x', '1']])).error, /Unknown line/);
  assert.deepEqual(buildReturns(items, new Map()), { lines: [] });
});

// ---------- Launch control (migration 014) ------------------------------------
const launch = await import('../web/js/core/launch.js');

test('launch: the two modes decide which admin modules hide; the full app hides nothing', () => {
  assert.deepEqual([...launch.hiddenModules({ pricing_mode: 'advanced', stock_mode: 'counted' })], []);
  assert.deepEqual([...launch.hiddenModules({ pricing_mode: 'simple', stock_mode: 'counted' })], ['pricing']);
  assert.deepEqual([...launch.hiddenModules({ pricing_mode: 'advanced', stock_mode: 'simple' })], ['inventory', 'procurement']);
  assert.deepEqual([...launch.hiddenModules({ pricing_mode: 'simple', stock_mode: 'simple' })], ['pricing', 'inventory', 'procurement']);
  assert.deepEqual([...launch.hiddenModules(undefined)], [], 'no settings read = full menu; the database still enforces');
  assert.equal(launch.isLite({ pricing_mode: 'simple', stock_mode: 'simple' }), true);
  assert.equal(launch.isLite({ pricing_mode: 'simple', stock_mode: 'counted' }), false);
});

test('launch: the dashboard summary names what is off and says nothing when everything is on', () => {
  const sectors = [{ name: 'Restaurants', is_active: false }, { name: 'Army cantonments', is_active: true }];
  assert.deepEqual(launch.launchSummary({ pricing_mode: 'simple', stock_mode: 'simple' }, sectors), [
    'Live for Army cantonments · not yet: Restaurants',
    'Simple pricing: prices are typed on the product form',
    'Simple stock: in stock / out of stock only, no quantities',
  ]);
  assert.deepEqual(launch.launchSummary({ pricing_mode: 'advanced', stock_mode: 'counted' }, [{ name: 'Restaurants', is_active: true }]), []);
});

// ---------- Payments & credit (migration 015) ---------------------------------
const recv = await import('../web/js/core/receivables.js');

test('fifoAllocate: oldest due first, each item up to its balance, the rest on account (mirrors allocate_customer_credits)', () => {
  const items = [
    { id: 'b', kind: 'order', number: 'ORD-2', balance: 100, due_date: '2026-10-20', item_date: '2026-10-13' },
    { id: 'a', kind: 'order', number: 'ORD-1', balance: 239, due_date: '2026-10-19', item_date: '2026-10-12' },
    { id: 'c', kind: 'debit_note', number: 'DN-1', balance: 40, due_date: null, item_date: '2026-10-14' },
    { id: 'paid', kind: 'order', number: 'ORD-0', balance: 0, due_date: '2026-10-01', item_date: '2026-09-24' },
  ];
  assert.deepEqual(recv.fifoAllocate(300, items), { lines: [{ id: 'a', kind: 'order', number: 'ORD-1', amount: 239 }, { id: 'b', kind: 'order', number: 'ORD-2', amount: 61 }], leftover: 0 });
  assert.deepEqual(recv.fifoAllocate(400, items).leftover, 21);
  assert.deepEqual(recv.fifoAllocate(400, items).lines.map((l) => l.id), ['a', 'b', 'c'], 'a null due date sorts last');
  assert.deepEqual(recv.fifoAllocate(0, items), { lines: [], leftover: 0 });
});

test('agingTotals, daysOverdue and agingBucket match the report columns', () => {
  const totals = recv.agingTotals([
    { outstanding: 239, current_due: 0, d1_30: 239, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 239, unapplied_credit: 0 },
    { outstanding: -61, current_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 0, unapplied_credit: 61 },
  ]);
  assert.equal(totals.outstanding, 178); assert.equal(totals.d1_30, 239); assert.equal(totals.unapplied_credit, 61);
  assert.equal(recv.daysOverdue('2026-10-19', '2026-10-20'), 1);
  assert.equal(recv.daysOverdue('2026-10-21', '2026-10-20'), 0);
  assert.equal(recv.daysOverdue(null, '2026-10-20'), 0);
  assert.deepEqual([0, 1, 30, 31, 60, 61, 90, 91].map(recv.agingBucket), ['current', '1–30', '1–30', '31–60', '31–60', '61–90', '61–90', '90+']);
});


// ---------- Customer edit window (migration 017) ------------------------------
const custOrders = await import('../web/js/pages/restaurant/orders.js');

test('canCustomerChange: inside window = true, past window = false, status not placed = false, window 0 = never', () => {
  const terms = { customer_edit_window_minutes: 15 };
  const fresh = { status: 'placed', created_at: new Date(Date.now() - 5 * 60_000).toISOString() };
  const stale = { status: 'placed', created_at: new Date(Date.now() - 20 * 60_000).toISOString() };
  assert.equal(custOrders.canCustomerChange(fresh, terms), true);
  assert.equal(custOrders.canCustomerChange(stale, terms), false);
  assert.equal(custOrders.canCustomerChange({ ...fresh, status: 'confirmed' }, terms), false);
  assert.equal(custOrders.canCustomerChange(fresh, { customer_edit_window_minutes: 0 }), false);
  assert.equal(custOrders.canCustomerChange(fresh, undefined), true, 'default window is 15');
});

test('minutesLeftToChange rounds up and bottoms out at 0', () => {
  const terms = { customer_edit_window_minutes: 15 };
  const t = (minutesAgo) => ({ created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() });
  assert.ok([3, 4].includes(custOrders.minutesLeftToChange(t(11), terms)), 'about 4 min left');
  assert.equal(custOrders.minutesLeftToChange(t(20), terms), 0);
  assert.ok([14, 15].includes(custOrders.minutesLeftToChange(t(0.5), terms)), 'nearly a full window');
});


// ---------- Notifications & support (migration 018) ---------------------------
const notify = await import('../web/js/core/notify.js');

test('renderTemplate fills known placeholders and leaves unknown ones visible (mirrors render_template in SQL)', () => {
  assert.equal(notify.renderTemplate('Hi {customer}, order {order} total {total} {unknown} {', { customer: 'Spice Hut', order: 'ORD-1', total: '₹10' }),
    'Hi Spice Hut, order ORD-1 total ₹10 {unknown} {');
  assert.equal(notify.renderTemplate(null, {}), '');
  assert.equal(notify.renderTemplate('{a}{a}', { a: 'x' }), 'xx');
  assert.deepEqual(notify.templatePlaceholders('{order} and {total} and {order}'), ['order', 'total']);
  assert.deepEqual(notify.unknownPlaceholders('{order} {totl}', ['order', 'total']), ['totl']);
});

test('phoneDigits normalises Indian numbers like phone_for_sms; tel / WhatsApp / map hrefs follow', () => {
  assert.equal(notify.phoneDigits('+91 99000 11111'), '919900011111');
  assert.equal(notify.phoneDigits('09900011111'), '919900011111');
  assert.equal(notify.phoneDigits('9900011111'), '919900011111');
  assert.equal(notify.phoneDigits('12345'), null);
  assert.equal(notify.telHref('99000 11111'), 'tel:+919900011111');
  assert.equal(notify.whatsappHref('9900011111', 'Hi there'), 'https://wa.me/919900011111?text=Hi%20there');
  assert.equal(notify.whatsappHref('123'), null);
  assert.equal(notify.mapHref(17.6868, 83.2185), 'https://www.google.com/maps?q=17.6868,83.2185');
  assert.equal(notify.mapHref(null, null, '12 MG Road'), 'https://www.google.com/maps/search/12%20MG%20Road');
  assert.equal(notify.mapHref(null, null, ''), null);
  assert.equal(notify.contactLinks('12'), '', 'no usable number → nothing rendered');
  assert.match(notify.contactLinks('9900011111', 'x').toString(), /tel:\+919900011111.*wa\.me\/919900011111\?text=x/);
});


// ---------- Reports & dashboard (migration 019) ------------------------------
const reports = await import('../web/js/core/reports.js');
const pageMod = await import('../web/js/pages/page.js');

test('reportTotals sums the money and count columns; reportColumns differ for product groupings', () => {
  const rows = [{ orders: 2, subtotal: 100, tax: 5, delivery_fee: 0, total: 105, cancelled: 1 }, { orders: 1, subtotal: 50.5, tax: 0, delivery_fee: 49, total: 99.5, cancelled: 0 }];
  assert.deepEqual(reports.reportTotals(rows), { orders: 3, quantity: 0, subtotal: 150.5, tax: 5, delivery_fee: 49, total: 204.5, cancelled: 1 });
  assert.deepEqual(reports.reportColumns('day').map((c) => c.key), ['label', 'orders', 'subtotal', 'tax', 'delivery_fee', 'total', 'cancelled']);
  assert.deepEqual(reports.reportColumns('product').map((c) => c.key), ['label', 'orders', 'quantity', 'total', 'cancelled']);
  assert.equal(reports.reportColumns('customer')[0].label, 'Customer');
});

test('barHeights scales to the peak and handles an all-zero series; date helpers', () => {
  assert.deepEqual(reports.barHeights([0, 50, 100, 25]), [0, 50, 100, 25]);
  assert.deepEqual(reports.barHeights([0, 0]), [0, 0]);
  assert.deepEqual(reports.barHeights(['3', null], 60), [60, 0]);
  const r = reports.lastNDays(7);
  assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/); assert.ok(r.from < r.to);
  assert.equal(reports.shortDate('2026-10-26'), '26 Oct');
});

test('renderBody turns "## " lines into headings and blank lines into paragraphs, escaping HTML', () => {
  const out = pageMod.renderBody('Intro <b>x</b>\n\n## Heading\n\nPara one.\nStill one.').map((h) => h.toString());
  assert.equal(out.length, 3);
  assert.match(out[0], /^<p>Intro &lt;b&gt;x&lt;\/b&gt;<\/p>$/);
  assert.equal(out[1], '<h2>Heading</h2>');
  assert.match(out[2], /^<p>Para one\.\nStill one\.<\/p>$/);
});


// ---------- Ordering + (migration 021) --------------------------------------
const bulk = await import('../web/js/core/bulk-order.js');
const calc = await import('../web/js/core/calculators.js');
const { parseCsv: parseCsvForBulk } = await import('../web/js/core/csv.js');

test('csvToCartLines matches by sku or product name, raises to the minimum, merges duplicates and reports problems', () => {
  const products = [{ id: 'p1', sku: 'VEG-001', name: 'Tomato', min_order_qty: 5, in_stock: true, is_active: true },
                    { id: 'p2', sku: 'DAI-002', name: 'Paneer', min_order_qty: 1, in_stock: false, is_active: true }];
  const parsed = parseCsvForBulk('sku,product,quantity\nveg-001,,2\n,tomato,10\n,Paneer,3\nXXX,,4\nVEG-001,,abc\n');
  const r = bulk.csvToCartLines(parsed, products);
  assert.deepEqual(r.lines, [{ product_id: 'p1', quantity: 15, name: 'Tomato' }]);   // 2 → raised to 5, + 10
  assert.equal(r.problems.length, 4);
  assert.match(r.problems[0], /raised to its minimum of 5/);
  assert.match(r.problems[1], /Paneer is not available/);
  assert.match(r.problems[2], /"XXX" is not in the catalogue/);
  assert.match(r.problems[3], /must be a number/);
  assert.deepEqual(bulk.csvToCartLines(parseCsvForBulk('foo,bar\n1,2'), products).problems, ['The file needs a "sku" (or "product") column and a "quantity" column.']);
  assert.equal(bulk.bulkOrderTemplate(products).split('\r\n')[1], 'VEG-001,Tomato,5');
});

test('deliveryFeeEstimate mirrors the minimum-order rule; creditCostEstimate values the float', () => {
  const sector = { min_order_value: 2000, delivery_fee_below_mov: 99 };
  assert.deepEqual(calc.deliveryFeeEstimate(sector, 2500), { mov: 2000, shortfall: 0, fee: 0, canOrder: true, total: 2500 });
  assert.deepEqual(calc.deliveryFeeEstimate(sector, 1500), { mov: 2000, shortfall: 500, fee: 99, canOrder: true, total: 1599 });
  assert.equal(calc.deliveryFeeEstimate({ min_order_value: 2000, delivery_fee_below_mov: 0 }, 1500).canOrder, false);
  assert.deepEqual(calc.creditCostEstimate(150000, 30, 18), { cashInHand: 150000, yearlyValue: 27000, monthlyValue: 2250 });
  assert.deepEqual(calc.creditCostEstimate(0, 7), { cashInHand: 0, yearlyValue: 0, monthlyValue: 0 });
});
