// =============================================================================
// appatlas.test.js — tests for the AppAtlas knowledge engine (tools/appatlas).
// Small fixtures for each scanner, then the real repository: every route is a
// feature, every annotation is valid, every rpc api.js calls is defined in a
// migration, a schema change makes reviewed features stale (transitively), and
// the generated website renders every view without errors or unescaped data.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { parse, stringify } from '../tools/appatlas/lib/yaml.js';
import { splitStatements, scanMigration, buildSchema, scanSecurityTests } from '../tools/appatlas/lib/scan-sql.js';
import { scanRoutes, scanWrappers, exportBody, importCycles } from '../tools/appatlas/lib/scan-web.js';
import { validateAnnotation, matchTroubleshooting } from '../tools/appatlas/lib/annotations.js';
import { reach, compareMigrations } from '../tools/appatlas/lib/graph.js';
import { build } from '../tools/appatlas/lib/build.js';
import { renderSite } from '../tools/appatlas/lib/site.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let cached;
const repo = () => (cached ??= build(ROOT, { git: false }));

// ---------- yaml ----------
test('appatlas yaml: round-trips maps, lists of maps, quotes and block text', () => {
  const value = { id: 'a-b', n: 3, ok: true, screens: ['admin#orders'], admin: { what: "It's \"fine\": yes", steps: ['one', 'two'],
    errors: [{ symptom: 'x', solution: 'y' }], note: 'line one\n\nline three' }, empty: [] };
  assert.deepEqual(parse(stringify(value)), value);
  assert.deepEqual(parse('a: [x, y]  # comment\nb: plain words # c\n'), { a: ['x', 'y'], b: 'plain words' });
});

test('appatlas yaml: refuses bad indentation, tabs, duplicate keys and flow maps with a line number', () => {
  assert.throws(() => parse('a: 1\n  b: 2\n'), /line 2/);
  assert.throws(() => parse('a:\n\t- x\n'), /tabs/);
  assert.throws(() => parse('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parse('a: {b: 1}\n'), /flow maps/);
});

// ---------- sql ----------
const SQL = `
create table public.orders (id uuid primary key, status text not null, total numeric(12,2), constraint c check (total >= 0));
comment on table public.orders is 'One customer order.';
create or replace function public.place_order(p_items jsonb, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_permission('orders', 'edit') then raise exception 'You may not; ask a manager'; end if;
  insert into public.orders (status) values ('placed'); -- a ; inside a comment
  perform public.log_it('x;y');
  return null;
end $$;
create function public.log_it(p text) returns void language sql as $$ insert into public.audit (t) values (p) $$;
create policy orders_select on public.orders for select to authenticated using (true);
create trigger on_auth on auth.users after insert for each row execute function public.log_it();
alter function public.place_order(jsonb, text) rename to place_order_legacy;
`;

test('appatlas sql: statements split on ; but not inside $$ bodies, strings or comments', () => {
  const parts = splitStatements(SQL);
  assert.equal(parts.length, 7);
  assert.match(parts[2].text, /perform public\.log_it\('x;y'\)/);
});

test('appatlas sql: a function records its writes, calls, permission checks and refusal messages', () => {
  const fn = scanMigration('x.sql', SQL).find((f) => f.kind === 'function' && f.name === 'place_order');
  assert.deepEqual(fn.args, ['p_items', 'p_note']);
  assert.deepEqual(fn.writes, ['orders']);
  assert.deepEqual(fn.calls, ['has_permission', 'log_it']);
  assert.deepEqual(fn.permissions, ['orders:edit']);
  assert.deepEqual(fn.errors, ['You may not; ask a manager']);
  assert.equal(fn.securityDefiner, true);
  assert.equal(fn.searchPathSet, true);
});

test('appatlas sql: buildSchema follows renames, trigger schemas and table comments', () => {
  const s = buildSchema([{ path: 'supabase/migrations/001_x.sql', text: SQL }]);
  assert.ok(s.functions.place_order_legacy?.legacy, 'renamed function kept as legacy');
  assert.equal(s.functions.place_order, undefined);
  assert.equal(s.tables.orders.comment, 'One customer order.');
  assert.deepEqual(s.tables.orders.columns, ['id', 'status', 'total']);
  assert.equal(s.triggers[0].table, 'auth.users');
  assert.equal(Object.keys(s.policies.orders).length, 1);
});

test('appatlas sql: each security check is tied to the SQL written just before it', () => {
  const checks = scanSecurityTests(`
  perform public.alpha();
  v := v || jsonb_build_array('PASS T1a alpha works');
  perform public.beta();
  v := v || jsonb_build_array(case when x then 'PASS T1b beta works' else 'FAIL T1b' end);`);
  assert.deepEqual(checks.map((c) => [c.id, c.functions]), [['T1a', ['alpha']], ['T1b', ['beta']]]);
});

// ---------- web ----------
test('appatlas web: routes, guard modules and render functions come from main.js', () => {
  const { routes, fallback } = scanRoutes(`startRouter({ fallback: '#dashboard', routes: {
    '#dashboard': guard('dashboard', (c) => renderDashboard(c, me)),
    '#product/': withBanner((c, id) => renderProduct(c, state, id)) } });`);
  assert.equal(fallback, '#dashboard');
  assert.deepEqual(routes.map((r) => [r.route, r.module, r.render]), [['#dashboard', 'dashboard', 'renderDashboard'], ['#product/', null, 'renderProduct']]);
});

test('appatlas web: api.js wrappers record rpc, tables with their operation, buckets and Edge Functions', () => {
  const w = scanWrappers(`
export async function saveThing(x) { return unwrap(await supabase.from('things').upsert(x).select()); }
export async function place(items) { return unwrap(await supabase.rpc('place_order', { p_items: items })); }
export async function upload(f) { await supabase.storage.from(config.photoBucket).upload('a', f); }
export async function invite(e) { return supabase.functions.invoke('invite-staff', { body: { e } }); }`, { photoBucket: 'product-photos' });
  assert.deepEqual(w.saveThing.tables, { things: ['select', 'upsert'] });
  assert.deepEqual(w.place.rpcs, ['place_order']);
  assert.deepEqual(w.upload.storage, ['product-photos']);
  assert.deepEqual(w.invite.edge, ['invite-staff']);
});

test('appatlas web: exportBody returns only the named export, so borrowed helpers stay precise', () => {
  const code = 'export function settingsTabs() { return tabs; }\nexport async function renderSettings(c) { await resetTestData(); }\n';
  assert.match(exportBody(code, 'settingsTabs'), /return tabs/);
  assert.doesNotMatch(exportBody(code, 'settingsTabs'), /resetTestData/);
});

test('appatlas web: Tarjan finds an import cycle', () => {
  const m = { a: { imports: [{ file: 'b' }] }, b: { imports: [{ file: 'a' }] }, c: { imports: [{ file: 'a' }] } };
  assert.deepEqual(importCycles(m), [['a', 'b']]);
});

// ---------- graph ----------
test('appatlas graph: reach follows function calls and the triggers their writes fire', () => {
  const schema = { functions: {
    a: { reads: ['x'], writes: ['orders'], calls: ['b'], permissions: ['orders:edit'], roles: [], errors: ['A fails'] },
    b: { reads: [], writes: ['items'], calls: [], permissions: [], roles: [], errors: [] },
    audit: { reads: [], writes: ['audit_log'], calls: [], permissions: [], roles: [], errors: [] } },
    triggers: [{ table: 'orders', function: 'audit' }] };
  const r = reach(schema, ['a']);
  assert.deepEqual(r.functions, ['a', 'audit', 'b']);
  assert.deepEqual(r.writes, ['audit_log', 'items', 'orders']);
  assert.deepEqual(reach(schema, ['a'], { triggers: false }).writes, ['items', 'orders']);
});

test('appatlas graph: migrations are applied, applied by hand, not applied, or live only', () => {
  const repoMigs = [
    { file: '001_core.sql', name: 'core', created: ['table:orders'] },
    { file: '002_reset.sql', name: 'reset', created: ['function:reset_test_data'] },
    { file: '003_new.sql', name: 'new', created: ['function:not_there'] },
  ];
  const live = { database: { migrations: [{ version: '9', name: 'core' }, { version: '10', name: 'extra_v2' }],
    functions: { reset_test_data: {} }, tables: { orders: {} } } };
  const { rows, liveOnly } = compareMigrations(repoMigs, live);
  assert.deepEqual(rows.map((r) => r.live), ['applied', 'applied-by-hand', 'not-applied']);
  assert.deepEqual(liveOnly, [{ version: '10', name: 'extra_v2' }]);
});

// ---------- annotations ----------
test('appatlas annotations: unknown keys, a wrong file name and an unsigned "reviewed" are errors', () => {
  const errors = validateAnnotation({ feature_id: 'x', name: 'X', status: 'reviewed', admin: { what_if_wong: 'typo' } }, 'appatlas/annotations/y.yaml');
  assert.ok(errors.some((e) => /unknown key "what_if_wong"/.test(e)));
  assert.ok(errors.some((e) => /file name must be x\.yaml/.test(e)));
  assert.ok(errors.some((e) => /reviewed_by and reviewed_on/.test(e)));
});

test('appatlas troubleshooting: matching is plain words, case and punctuation ignored', () => {
  const entries = [{ id: 'a', symptom: 'Cannot approve a customer', match: ['no warehouse'], features: [] }, { id: 'b', symptom: 'Dispatch fails', match: [], features: [] }];
  assert.deepEqual(matchTroubleshooting(entries, 'CANNOT approve a customer!').map((e) => e.id), ['a']);
  assert.deepEqual(matchTroubleshooting(entries, 'they have No Warehouse').map((e) => e.id), ['a']);
  assert.deepEqual(matchTroubleshooting(entries, 'something else'), []);
});

// ---------- the real repository ----------
test('appatlas repo: every route in every main.js is a feature with an annotation', () => {
  const k = repo();
  for (const role of ['admin', 'restaurant']) {
    const src = readFileSync(join(ROOT, `web/js/pages/${role}/main.js`), 'utf8');
    for (const r of scanRoutes(src).routes) {
      const id = `${role}-${r.route.replace(/^#/, '').replace(/\/$/, '')}`;
      assert.ok(k.features[id], `feature ${id} for ${role}${r.route}`);
      assert.ok(k.features[id].annotation, `${id} has an annotation`);
    }
  }
  assert.ok(k.features['delivery-app'] && k.features['restaurant-cart']);
});

test('appatlas repo: annotations and the troubleshooting catalog are valid', () => {
  const k = repo();
  assert.deepEqual(k.health.annotationErrors, []);
  assert.deepEqual(k.health.troubleErrors, []);
});

test('appatlas repo: every rpc api.js calls is defined in a migration', () => {
  const k = repo();
  const missing = Object.values(k.wrappers).flatMap((w) => w.rpcs.filter((r) => !k.schema.functions[r]).map((r) => `${w.name} → ${r}`));
  assert.deepEqual(missing, []);
});

test('appatlas repo: a feature only borrows the api calls of the helper it imports', () => {
  const k = repo();
  assert.ok(!k.features['admin-help-centre'].wrappers.includes('resetTestData'), 'settingsTabs does not bring the reset button');
  assert.ok(k.features['admin-orders'].wrappers.includes('recordPayment'), 'receiptDialog brings recordPayment');
});

test('appatlas repo: a new migration on a table makes every reviewed feature using it stale, and only those', () => {
  const dir = mkdtempSync(join(tmpdir(), 'appatlas-'));
  try {
    for (const p of ['web', 'supabase', 'docs', 'appatlas', 'tools', 'tests/pages.test.js', 'tests/unit.test.js', 'package.json']) {
      cpSync(join(ROOT, p), join(dir, p), { recursive: true, filter: (src) => !src.includes(`${'appatlas'}/out`) });
    }
    const cli = (...args) => execFileSync(process.execPath, [join(dir, 'tools/appatlas/cli.js'), ...args], { cwd: dir, encoding: 'utf8' });
    cli('review', 'admin-orders', '--by', 'Tester', '--date', '2026-10-30');
    cli('review', 'admin-help-centre', '--by', 'Tester', '--date', '2026-10-30');
    assert.match(cli('check'), /OK: no stale/);
    writeFileSync(join(dir, 'supabase/migrations/20991231000001_test.sql'), 'alter table public.orders add column test_note text;\n');
    let out = '';
    try { cli('check'); } catch (e) { out = e.stdout; }
    assert.match(out, /STALE admin-orders/);
    assert.match(out, /Table orders changed: it is now touched by 20991231000001_test\.sql/);
    assert.doesNotMatch(out, /STALE admin-help-centre/, 'help articles do not use orders');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the website ----------
function loadSite(k, hash = 'home') {
  const page = renderSite(k, { root: ROOT });
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', url: `http://localhost/#${hash}`,
    beforeParse(window) { window.scrollTo = () => {}; window.addEventListener('error', (e) => errors.push(e.message)); } });
  return { dom, errors, page };
}

test('appatlas site: the inline script is closed only once (no </script> inside it)', () => {
  const { page } = loadSite(repo());
  const script = page.slice(page.indexOf('<script>\n"use strict"'));
  assert.equal(script.split('</script>').length, 2);
});

test('appatlas site: every view renders in both modes without errors', () => {
  const k = repo();
  const { dom, errors } = loadSite(k);
  const { window } = dom;
  const views = ['home', 'features', 'manual', 'troubleshoot', 'onboard', 'health', 'map', 'db', 'functions', 'api', 'infra', 'live', 'timeline', 'adrs', 'impact',
    'f-admin-orders', 'f-restaurant-cart', 'f-infra-supabase-auth', 'm-orders', 't-orders', 'fn-place-order-core', 'adr-0007', 'onboard-city-manager', 'f-does-not-exist'];
  for (const mode of ['admin', 'dev']) {
    window.document.querySelector(`.mode button[data-mode="${mode}"]`).click();
    for (const v of views) {
      window.location.hash = v;
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
      const h1 = window.document.querySelector('#view h1');
      assert.ok(h1 && h1.textContent.trim(), `${mode} #${v} has a heading`);
    }
  }
  window.location.hash = 'f-admin-orders';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  window.document.querySelector('[data-tab="admin"]').click();
  assert.equal(window.document.querySelectorAll('.q').length, 10, 'ten admin questions');
  assert.deepEqual(errors, []);
});

test('appatlas site: data is escaped, never run as markup', () => {
  const k = structuredClone(repo());
  k.features['admin-orders'].name = '<img src=x onerror="window.__pwned=1">';
  const { dom } = loadSite(k, 'f-admin-orders');
  assert.equal(dom.window.__pwned, undefined);
  assert.equal(dom.window.document.querySelector('#view img[src="x"]'), null);
  assert.match(dom.window.document.querySelector('#view h1').textContent, /<img/);
});

test('appatlas site: troubleshooting finds the runbook entry and the database message', () => {
  const { dom } = loadSite(repo(), 'troubleshoot');
  const { window } = dom;
  const input = window.document.querySelector('#tq');
  input.value = 'Cannot approve a customer';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(window.document.querySelector('#tr').textContent, /no warehouse yet/);
});

test('appatlas build: the same repository gives the same JSON (deterministic)', () => {
  const a = JSON.stringify(build(ROOT, { git: false }));
  const b = JSON.stringify(build(ROOT, { git: false }));
  assert.equal(a, b);
});
