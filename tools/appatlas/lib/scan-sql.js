// =============================================================================
// scan-sql.js — reads supabase/migrations/*.sql in order and records, for each
// table / function / policy / trigger / bucket, which migration created or last
// changed it, plus what every function reads, writes, calls, checks and refuses.
//
// It relies on two project rules: every object is written `public.name`
// (SECURITY DEFINER functions run with search_path = ''), and migrations are
// never edited after they are applied (AGENTS.md rule 4) — so "the migrations
// that touched table X" is a stable fact that only grows. Staleness uses that:
// a new migration that alters `orders` makes every feature using orders stale.
// Also reads supabase/tests/security_test.sql into numbered checks (T63a …).
// =============================================================================

import { basename } from 'node:path';
import { readText, sha, uniq } from './text.js';

/** Split SQL into statements, keeping $$ bodies, quotes and comments intact. */
export function splitStatements(sql) {
  const out = [];
  let start = 0, i = 0, dollar = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length; dollar = null; continue; }
      i++; continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? sql.length : e + 2; continue; }
    if (ch === "'") { i++; while (i < sql.length) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") break; i++; } i++; continue; }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
      if (m) { dollar = m[0]; i += m[0].length; continue; }
    }
    if (ch === ';') { out.push({ text: sql.slice(start, i).trim(), offset: start }); start = i + 1; }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push({ text: tail, offset: start });
  return out.filter((s) => s.text.replace(/--[^\n]*/g, '').trim());
}

const noComments = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
const NAME = '(?:public\\.)?"?([a-z_][a-z0-9_]*)"?';

/** What a function body does: tables read / written, functions called, checks and refusals. */
export function analyseBody(body) {
  const b = noComments(body);
  const grab = (re) => uniq([...b.matchAll(re)].map((m) => m[1].toLowerCase()));
  const writes = uniq([
    ...grab(/insert\s+into\s+public\.([a-z_][a-z0-9_]*)/gi),
    ...grab(/\bupdate\s+public\.([a-z_][a-z0-9_]*)/gi),
    ...grab(/delete\s+from\s+public\.([a-z_][a-z0-9_]*)/gi),
  ]);
  const reads = grab(/(?:from|join)\s+public\.([a-z_][a-z0-9_]*)/gi);
  // "insert into public.orders (col…)" is a table, not a call: skip names right after INTO / TABLE.
  const calls = grab(/(?<!(?:into|table|references|update)\s+)public\.([a-z_][a-z0-9_]*)\s*\(/gi).filter((n) => !writes.includes(n));
  const permissions = uniq([...b.matchAll(/has_permission\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g)].map((m) => `${m[1]}:${m[2]}`));
  const roles = uniq([...b.matchAll(/app_role\(\)\s*(?:=|<>|!=|in)\s*\(?\s*'([a-z_]+)'/g)].map((m) => m[1]));
  // raise exception 'text with % placeholders', args … → keep the text the person sees.
  const errors = uniq([...body.matchAll(/raise\s+exception\s+'((?:''|[^'])*)'/gi)]
    .map((m) => m[1].replace(/''/g, "'").replace(/%/g, '…').trim())
    .filter((t) => t && !/^[A-Z_]+$/.test(t)));
  // "from public.my_fn()" reads a set-returning function, not a table.
  return { reads: reads.filter((t) => !calls.includes(t)), writes, calls, permissions, roles, errors,
    usesAuthUid: /auth\.uid\(\)/.test(b) };
}

function argsOf(sig) {
  return sig.split(',').map((a) => a.trim()).filter(Boolean)
    .map((a) => a.replace(/\s+default\s+[\s\S]*$/i, '').replace(/^(in|out|inout)\s+/i, '').split(/\s+/)[0]);
}

/** Scan one migration file into a list of facts. */
export function scanMigration(file, sql) {
  const facts = [];
  for (const { text } of splitStatements(sql)) {
    const s = noComments(text).trim();
    let m;
    if ((m = new RegExp(`^create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${NAME}\\s*\\(`, 'i').exec(s))) {
      const inner = s.slice(m[0].length, s.lastIndexOf(')'));
      const cols = [];
      let depth = 0, cur = '';
      for (const ch of inner) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; } else cur += ch; }
      cols.push(cur);
      const columns = cols.map((c) => c.trim()).filter((c) => c && !/^(constraint|primary|unique|check|foreign|exclude)\b/i.test(c))
        .map((c) => c.split(/\s+/)[0].replace(/"/g, ''));
      facts.push({ kind: 'table', name: m[1], columns });
    } else if ((m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?view\\s+${NAME}`, 'i').exec(s))) {
      facts.push({ kind: 'view', name: m[1], ...analyseBody(text) });
    } else if ((m = new RegExp(`^alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?${NAME}`, 'i').exec(s))) {
      const added = [...s.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)/gi)].map((x) => x[1]);
      facts.push({ kind: 'alter', name: m[1], added, rls: /enable\s+row\s+level\s+security/i.test(s) });
    } else if ((m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+${NAME}\\s*\\(`, 'i').exec(s))) {
      const [sig] = (() => { let d = 1, j = m[0].length; for (; j < s.length && d; j++) { if (s[j] === '(') d++; if (s[j] === ')') d--; } return [s.slice(m[0].length, j - 1)]; })();
      const body = (/\$([A-Za-z_]*)\$([\s\S]*)\$\1\$/.exec(text) || [])[2] ?? '';
      facts.push({
        kind: 'function', name: m[1], args: argsOf(sig),
        returns: (/returns\s+(setof\s+)?([a-z_.]+(?:\[\])?)/i.exec(s.replace(/\$([A-Za-z_]*)\$[\s\S]*\$\1\$/, '')) || [])[0]?.replace(/^returns\s+/i, '') ?? '',
        securityDefiner: /security\s+definer/i.test(s.replace(/\$([A-Za-z_]*)\$[\s\S]*\$\1\$/, '')),
        searchPathSet: /set\s+search_path/i.test(s.replace(/\$([A-Za-z_]*)\$[\s\S]*\$\1\$/, '')),
        trigger: /returns\s+trigger/i.test(s),
        bodyHash: sha(body),
        ...analyseBody(body),
      });
    } else if ((m = new RegExp(`^alter\\s+function\\s+${NAME}\\s*\\([\\s\\S]*?\\)\\s+rename\\s+to\\s+"?([a-z_][a-z0-9_]*)`, 'i').exec(s))) {
      facts.push({ kind: 'rename-function', name: m[1], to: m[2] });
    } else if ((m = new RegExp(`^drop\\s+function\\s+(?:if\\s+exists\\s+)?${NAME}`, 'i').exec(s))) {
      facts.push({ kind: 'drop-function', name: m[1] });
    } else if ((m = /^(create|alter)\s+policy\s+"?([^"\s]+)"?\s+on\s+([a-z_]+\.)?"?([a-z_][a-z0-9_]*)/i.exec(s))) {
      m = [m[0], m[2], (m[3] && m[3] !== 'public.' ? m[3] : '') + m[4], m[1].toLowerCase()];
      const cmd = (/\bfor\s+(select|insert|update|delete|all)\b/i.exec(s) || [, 'all'])[1].toLowerCase();
      const to = (/\bto\s+([a-z_, ]+?)(?:\s+using|\s+with|$)/i.exec(s) || [, 'public'])[1].trim();
      const using = (/\busing\s*\(([\s\S]*)\)\s*(?:with\s+check|$)/i.exec(s) || [, ''])[1].replace(/\s+/g, ' ').trim();
      const check = (/with\s+check\s*\(([\s\S]*)\)\s*$/i.exec(s) || [, ''])[1].replace(/\s+/g, ' ').trim();
      facts.push({ kind: m[3] === 'alter' ? 'alter-policy' : 'policy', name: m[1], table: m[2], cmd, to, using, check });
    } else if ((m = /^drop\s+policy\s+(?:if\s+exists\s+)?"?([^"\s]+)"?\s+on\s+([a-z_]+\.)?"?([a-z_][a-z0-9_]*)/i.exec(s))) {
      facts.push({ kind: 'drop-policy', name: m[1], table: (m[2] && m[2] !== 'public.' ? m[2] : '') + m[3] });
    } else if ((m = new RegExp(`^drop\\s+trigger\\s+(?:if\\s+exists\\s+)?"?([a-z_0-9]+)"?\\s+on\\s+${NAME}`, 'i').exec(s))) {
      facts.push({ kind: 'drop-trigger', name: m[1], table: m[2] });
    } else if ((m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+"?([a-z_0-9]+)"?[\\s\\S]*?\\bon\\s+${NAME}[\\s\\S]*?execute\\s+(?:function|procedure)\\s+${NAME}`, 'i').exec(s))) {
      const q = /\bon\s+([a-z_]+)\.([a-z_][a-z0-9_]*)/i.exec(s);   // trigger on auth.users, not public
      facts.push({ kind: 'trigger', name: m[1], table: q && q[1].toLowerCase() !== 'public' ? `${q[1]}.${q[2]}`.toLowerCase() : m[2], function: m[3] });
    } else if (/^insert\s+into\s+storage\.buckets/i.test(s)) {
      for (const v of s.matchAll(/\(\s*'([a-z0-9-]+)'\s*,\s*'[^']*'\s*,\s*(true|false)/gi)) facts.push({ kind: 'bucket', name: v[1], public: v[2].toLowerCase() === 'true' });
    } else if ((m = new RegExp(`^comment\\s+on\\s+(table|view|function)\\s+${NAME}[\\s\\S]*?\\bis\\s+'((?:''|[^'])*)'`, 'i').exec(s))) {
      facts.push({ kind: 'comment', on: m[1].toLowerCase() === 'function' ? 'function' : 'table', name: m[2], text: m[3].replace(/''/g, "'").replace(/\s+/g, ' ').trim() });
    } else if ((m = new RegExp(`^comment\\s+on\\s+column\\s+${NAME}\\.([a-z_0-9]+)\\s+is\\s+'((?:''|[^'])*)'`, 'i').exec(s))) {
      facts.push({ kind: 'column-comment', table: m[1], column: m[2], text: m[3].replace(/''/g, "'").replace(/\s+/g, ' ').trim() });
    }
  }
  return facts;
}

/** Fold every migration (in file order) into the current schema model. */
export function buildSchema(files) {
  const tables = {}, functions = {}, policies = {}, triggers = [], buckets = {}, migrations = [];
  const touch = (map, name, mig) => { (map[name].migrations ||= []).includes(mig) || map[name].migrations.push(mig); };
  for (const { path, text } of files) {
    const mig = basename(path);
    const facts = scanMigration(path, text);
    const created = [];
    for (const f of facts) {
      if (f.kind === 'table' || f.kind === 'view') {
        tables[f.name] ??= { name: f.name, kind: f.kind, columns: [], comment: '', columnComments: {}, migrations: [], createdIn: mig };
        if (f.columns) tables[f.name].columns = uniq([...tables[f.name].columns, ...f.columns]);
        if (f.kind === 'view') Object.assign(tables[f.name], { reads: f.reads });
        touch(tables, f.name, mig); created.push(`${f.kind}:${f.name}`);
      } else if (f.kind === 'alter') {
        if (!tables[f.name]) continue;
        tables[f.name].columns = uniq([...tables[f.name].columns, ...f.added]);
        if (f.rls) tables[f.name].rlsInRepo = true;
        if (f.added.length) touch(tables, f.name, mig);
      } else if (f.kind === 'function') {
        const prev = functions[f.name];
        functions[f.name] = { ...f, migrations: [...(prev?.migrations ?? []), mig], definedIn: mig, createdIn: prev?.createdIn ?? mig, comment: prev?.comment ?? '' };
        created.push(`function:${f.name}`);
      } else if (f.kind === 'rename-function') {
        // place_order → place_order_v7_legacy: the old body keeps living under its new name.
        if (functions[f.name]) { functions[f.to] = { ...functions[f.name], name: f.to, legacy: /_legacy$/.test(f.to), renamedIn: mig }; delete functions[f.name]; }
      } else if (f.kind === 'drop-function') {
        if (functions[f.name]) functions[f.name].droppedIn = mig;
      } else if (f.kind === 'policy') {
        (policies[f.table] ||= {})[f.name] = { ...f, migration: mig };
        if (tables[f.table]) touch(tables, f.table, mig);
      } else if (f.kind === 'alter-policy') {
        const old = policies[f.table]?.[f.name];
        if (old) policies[f.table][f.name] = { ...old, using: f.using || old.using, check: f.check || old.check, migration: mig };
        if (tables[f.table]) touch(tables, f.table, mig);
      } else if (f.kind === 'drop-trigger') {
        for (let k = triggers.length - 1; k >= 0; k--) if (triggers[k].name === f.name && triggers[k].table === f.table) triggers.splice(k, 1);
      } else if (f.kind === 'drop-policy') {
        if (policies[f.table]) delete policies[f.table][f.name];
      } else if (f.kind === 'trigger') {
        for (let k = triggers.length - 1; k >= 0; k--) if (triggers[k].name === f.name && triggers[k].table === f.table) triggers.splice(k, 1);
        triggers.push({ ...f, migration: mig });
      } else if (f.kind === 'bucket') {
        buckets[f.name] = { name: f.name, public: f.public, migration: mig };
      } else if (f.kind === 'comment') {
        if (f.on === 'table' && tables[f.name]) tables[f.name].comment = f.text;
        if (f.on === 'function' && functions[f.name]) functions[f.name].comment = f.text;
      } else if (f.kind === 'column-comment') {
        if (tables[f.table]) tables[f.table].columnComments[f.column] = f.text;
      }
    }
    // A function re-created later with the same name replaces the old one (a "drop" before a re-create is normal).
    for (const fn of Object.values(functions)) if (fn.droppedIn === mig && fn.definedIn === mig) delete fn.droppedIn;
    migrations.push({ file: mig, path, name: mig.replace(/^\d+_/, '').replace(/\.sql$/, ''), version: mig.split('_')[0], hash: sha(text), created });
  }
  return { tables, functions, policies, triggers, buckets, migrations };
}

/**
 * security_test.sql → [{ id: 'T63a', text, functions, tables }]. Each check gets the SQL
 * written between the previous check and itself: the statements that produce its PASS line.
 */
export function scanSecurityTests(sql) {
  const checks = [];
  let buffer = [];
  for (const line of sql.split('\n')) {
    buffer.push(line);
    const hits = [...line.matchAll(/'PASS (T\d+[a-z]?)\s+((?:''|[^'])*)'/g)];
    if (!hits.length) continue;
    const body = noComments(buffer.join('\n'));
    const functions = uniq([...body.matchAll(/public\.([a-z_][a-z0-9_]*)\s*\(/g)].map((m) => m[1]));
    const tables = uniq([...body.matchAll(/(?:from|into|update)\s+public\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]));
    for (const m of hits) checks.push({ id: m[1], text: m[2].replace(/''/g, "'").trim(), functions, tables });
    buffer = [];
  }
  return checks;
}

export function readMigrations(paths) { return paths.filter((p) => p.endsWith('.sql')).sort().map((path) => ({ path, text: readText(path) })); }
