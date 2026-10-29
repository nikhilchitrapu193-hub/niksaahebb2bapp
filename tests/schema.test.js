// Schema contract: every table, column, embed and function the browser asks for exists
// in the live database (snapshot in tests/fixtures/live-schema.json). The page tests use a
// fake client that accepts any name, so without this a wrong name only shows up as a red
// banner in the app ("Could not find the table …" / "Could not find a relationship …").
// After applying a migration, regenerate the snapshot: supabase/tests/schema_snapshot.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, auditWeb } from './helpers/schema-audit.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = loadSnapshot(resolve(ROOT, 'tests/fixtures/live-schema.json'));

test('every Supabase call in web/js matches the live schema', () => {
  const problems = auditWeb(resolve(ROOT, 'web/js'), schema, ROOT);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('the schema audit catches wrong tables, columns, embeds (missing or ambiguous) and function arguments', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(resolve(tmpdir(), 'audit-'));
  mkdirSync(resolve(dir, 'js'));
  writeFileSync(resolve(dir, 'js', 'bad.js'), `
    export async function a() { return supabase.from('customer_balances').select('*'); }
    export async function b() { return supabase.from('cities').select('*, sectors(*)').order('name'); }
    export async function c() { return supabase.from('slot_config').select('*').order('delivery_slot'); }
    export async function d() { return supabase.rpc('accept_quote', { p_quote_id: 1 }); }
    export async function e() { const values = { event: 'x', bogus: 1 }; return supabase.from('notification_settings').insert(values); }
    export async function f() { return supabase.from('orders').select('*, profiles(full_name)'); }
    export async function ok() { return supabase.from('ticket_messages').select('*, profiles:author_id(full_name)'); }`);
  const problems = auditWeb(resolve(dir, 'js'), schema, dir).join('\n');
  for (const fn of ['a()', 'b()', 'c()', 'd()', 'e()', 'f()']) assert.match(problems, new RegExp(`js/bad.js ${fn.replace(/[()]/g, '\\$&')}`));
  assert.doesNotMatch(problems, /ok\(\)/);
});
