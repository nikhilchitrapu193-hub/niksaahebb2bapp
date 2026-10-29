// =============================================================================
// schema-audit.js — reads every Supabase call in web/js and checks it against a
// snapshot of the live database (tests/fixtures/live-schema.json):
//   .from('table')          the table / view exists
//   .select('a, b(c)')      columns exist; every embed has a foreign key
//   .eq/.order/... ('col')  the column exists
//   .insert/.update/.upsert inline object keys (or a `const x = {…}` payload) are columns
//   .rpc('fn', { p_… })     the function exists and accepts those argument names
// Why: the page tests run on a fake client that accepts any name, so a wrong table,
// column or argument passes every other test and only fails in the browser.
// Pure text analysis (no JS parser) — good enough for the patterns api.js uses.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function loadSnapshot(file) {
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const cols = Object.fromEntries(Object.entries(snap.tables).map(([t, c]) => [t, new Set(c)]));
  const fks = snap.foreignKeys.map((s) => { const [l, r] = s.split('>'); const [t, c] = l.split('.'); return { t, c, r }; });
  return { cols, fks, functions: snap.functions };
}

// Blank out // and /* */ comments but keep string contents and positions.
function stripComments(src) {
  let out = '', q = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { out += ch; if (ch === '\\') { out += src[++i] ?? ''; continue; } if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; out += ch; continue; }
    if (ch === '/' && src[i + 1] === '/' ) { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } out += '\n'; continue; }
    if (ch === '/' && src[i + 1] === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i++; continue; }
    out += ch;
  }
  return out;
}

// From index i (just after an opening bracket) to its matching close: [inner, closeIndex].
function balanced(src, i, open = '(', close = ')') {
  let depth = 1, q = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (q) { if (ch === '\\') { j++; continue; } if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return [src.slice(i, j), j];
  }
  return [src.slice(i), src.length];
}

// The method chain after .from(...): [{ name, args }, …].
function chain(src, i) {
  const calls = [];
  for (;;) {
    const m = /^\s*\.\s*(\w+)\s*\(/.exec(src.slice(i, i + 200));
    if (!m) return calls;
    const [args, end] = balanced(src, i + m[0].length);
    calls.push({ name: m[1], args });
    i = end + 1;
  }
}

const literal = (a) => { const m = /^\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(a); return m && !m[2].includes('${') ? m[2] : null; };

// Top-level keys of an object literal that starts at text[0] === '{'.
function objectKeys(text) {
  const [body] = balanced(text, 1, '{', '}');
  const keys = []; let depth = 0, q = null, cur = '';
  const push = () => { const t = cur.trim(); cur = ''; if (!t || t.startsWith('...')) return; const k = t.split(/\s*:/)[0].trim().replace(/^['"]|['"]$/g, ''); if (/^\w+$/.test(k)) keys.push(k); };
  for (let j = 0; j < body.length; j++) {
    const ch = body[j];
    if (q) { cur += ch; if (ch === '\\') { cur += body[++j]; continue; } if (ch === q) q = null; continue; }
    if ("'\"`".includes(ch)) { q = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) push(); else cur += ch;
  }
  push();
  return keys;
}

// The keys a write sends: an inline {…}, [{…}], rows.map((r) => ({…})), or `name` declared as `const name = {…}` earlier in the function.
function payloadKeys(args, before) {
  const a = args.trim();
  if (a.startsWith('{')) return objectKeys(a);
  if (a.startsWith('[{')) return objectKeys(a.slice(1));
  const mapped = /\.map\(\s*\(?\w*\)?\s*=>\s*\(\s*\{/.exec(a);
  if (mapped) return objectKeys(a.slice(mapped.index + mapped[0].length - 1));
  const name = /^(\w+)\s*(?:[,)]|$)/.exec(a)?.[1];
  if (!name) return null;
  const decl = [...before.matchAll(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\{`, 'g'))].at(-1);
  return decl ? objectKeys(before.slice(decl.index + decl[0].length - 1)) : null;
}

function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function checkSelect(schema, table, sel, errors) {
  const { cols, fks } = schema;
  for (const item of splitTop(sel.replace(/\s+/g, ' '))) {
    if (item === '*' || /^count\b/.test(item)) continue;
    const embed = /^(?:(\w+):)?(\w+)(?:!(\w+))?\s*\(([\s\S]*)\)$/.exec(item);
    if (embed) {
      let [, , target, hint, inner] = embed;
      if (hint === 'inner' || hint === 'left') hint = null;
      // `alias:fk_column(...)` — the embed is named after this table's foreign-key column.
      if (!cols[target] && cols[table]?.has(target)) {
        const fk = fks.find((f) => f.t === table && f.c === target);
        if (!fk) { errors.push(`embed ${target}(…): ${table}.${target} is not a foreign key`); continue; }
        checkSelect(schema, fk.r, inner, errors);
        continue;
      }
      if (!cols[target]) { errors.push(`embed ${target}(…): no such table`); continue; }
      const between = fks.filter((f) => (f.t === table && f.r === target) || (f.t === target && f.r === table));
      const linked = hint ? between.filter((f) => f.c === hint || `${f.t}_${f.c}_fkey` === hint) : between;
      if (!linked.length) errors.push(`embed ${target}(…): no foreign key between ${table} and ${target}${hint ? ` via ${hint}` : ''}`);
      // Two foreign keys between the same tables: Supabase refuses the embed unless it names one (target!fk_column).
      else if (!hint && linked.length > 1) errors.push(`embed ${target}(…): ambiguous, ${linked.length} foreign keys between ${table} and ${target} (${linked.map((f) => `${f.t}.${f.c}`).join(', ')}); write ${target}!<column>(…)`);
      else checkSelect(schema, target, inner, errors);
      continue;
    }
    const col = item.replace(/^\w+:/, '').replace(/::\w+$/, '').replace(/->.*$/, '').trim();
    if (/^\w+$/.test(col) && !cols[table].has(col)) errors.push(`${table}.${col}: no such column`);
  }
}

const COLUMN_ARG = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'order', 'not', 'overlaps']);

/** Returns a list of "file fn(): problem" strings; empty when every call matches the snapshot. */
export function auditWeb(webJsDir, schema, root = webJsDir) {
  const { cols, functions } = schema;
  const files = [];
  (function walk(d) { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith('.js')) files.push(f); } })(webJsDir);
  const problems = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = relative(root, file).split('\\').join('/');
    const fnStarts = [...src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)];
    const fnAt = (i) => fnStarts.filter((m) => m.index < i).at(-1);
    const report = (i, what, errs) => { for (const e of new Set(errs)) problems.push(`${rel} ${fnAt(i)?.[1] ?? '?'}() ${what}: ${e}`); };

    for (const m of src.matchAll(/\.from\(\s*(['"`])(\w+)\1\s*\)/g)) {
      if (/storage\s*$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;   // storage buckets
      const table = m[2], errs = [];
      if (!cols[table]) { report(m.index, `from('${table}')`, ['no such table or view']); continue; }
      const fnStart = fnAt(m.index)?.index ?? 0;
      for (const c of chain(src, m.index + m[0].length)) {
        if (c.name === 'select') { const s = literal(c.args); if (s != null) checkSelect(schema, table, s, errs); }
        if (COLUMN_ARG.has(c.name) && !/foreignTable|referencedTable/.test(c.args)) {
          const col = literal(c.args);
          if (col && /^\w+$/.test(col) && !cols[table].has(col)) errs.push(`.${c.name}('${col}'): no such column`);
        }
        if (c.name === 'insert' || c.name === 'update' || c.name === 'upsert') {
          for (const k of payloadKeys(c.args, src.slice(fnStart, m.index)) ?? []) if (!cols[table].has(k)) errs.push(`.${c.name}() sends ${k}: no such column`);
          const conflict = /onConflict:\s*['"]([\w, ]+)['"]/.exec(c.args)?.[1];
          for (const k of conflict?.split(',').map((x) => x.trim()) ?? []) if (!cols[table].has(k)) errs.push(`onConflict ${k}: no such column`);
        }
      }
      if (errs.length) report(m.index, `from('${table}')`, errs);
    }

    for (const m of src.matchAll(/\.rpc\(\s*(['"`])(\w+)\1\s*(,\s*)?/g)) {
      const fn = m[2];
      if (!functions[fn]) { report(m.index, `rpc('${fn}')`, ['no such function']); continue; }
      const rest = src.slice(m.index + m[0].length).trimStart();
      if (!m[3] || !rest.startsWith('{')) continue;
      const keys = objectKeys(rest);
      if (!functions[fn].some((args) => keys.every((k) => args.includes(k)))) {
        report(m.index, `rpc('${fn}')`, [`arguments {${keys.join(', ')}} not accepted; the database takes (${functions[fn].map((a) => a.join(', ')).join(') or (')})`]);
      }
    }
  }
  return problems;
}
