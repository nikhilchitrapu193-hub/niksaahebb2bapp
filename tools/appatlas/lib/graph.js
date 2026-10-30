// =============================================================================
// graph.js — joins the scans into one knowledge graph and answers, per feature,
// the 10 admin questions and the developer facts.
//
// Where each answer comes from (shown on every answer as its "source"):
//   annotation   a person wrote it and reviewed it          → Reviewed
//   draft        written at setup (AI or developer), unchecked → Draft
//   code comment the screen's header comment (developer-written) → From code
//   permissions  the LIVE role_permissions matrix + has_permission() checks → Verified
//   graph        tables the feature's database functions read / write → Verified
//   database     raise-exception messages in those functions → Verified
//   missing      nothing to go on → "Documentation required" (never invented)
//
// Staleness (ADR 0026): a reviewed feature records the hash of every piece of
// evidence it depends on — its screen files, the api.js wrappers it calls, the
// current body of each database function it reaches, and for each table it reads
// or writes the list of migrations that touched that table. A new migration that
// alters `orders` therefore marks every feature using orders "Review needed",
// not just the one whose file changed. That is the transitive part.
// =============================================================================

import { QUESTIONS, matchTroubleshooting } from './annotations.js';
import { sha, uniq } from './text.js';

export const DOC_REQUIRED = 'Documentation required';

const AREA_LABEL = { restaurant: 'Customer app', delivery: 'Driver app', page: 'Website & printable pages', jobs: 'Background jobs', infrastructure: 'Infrastructure' };

/** Follow database function calls (and the triggers their writes fire) to everything they reach. */
export function reach(schema, startFns, { triggers = true } = {}) {
  const fns = new Set(), reads = new Set(), writes = new Set(), permissions = new Set(), roles = new Set(), errors = new Map();
  const triggerOn = {};
  for (const t of schema.triggers) (triggerOn[t.table] ||= []).push(t.function);
  const stack = [...startFns];
  while (stack.length) {
    const name = stack.pop();
    const f = schema.functions[name];
    if (!f || fns.has(name)) continue;
    fns.add(name);
    f.reads.forEach((t) => reads.add(t));
    f.writes.forEach((t) => writes.add(t));
    f.permissions.forEach((p) => permissions.add(p));
    f.roles.forEach((r) => roles.add(r));
    for (const e of f.errors) if (!errors.has(e)) errors.set(e, name);
    for (const c of f.calls) if (schema.functions[c]) stack.push(c);
    if (triggers) for (const t of f.writes) for (const tf of triggerOn[t] ?? []) stack.push(tf);
  }
  return { functions: [...fns].sort(), reads: [...reads].sort(), writes: [...writes].sort(),
    permissions: [...permissions].sort(), roles: [...roles].sort(), errors: [...errors].map(([text, fn]) => ({ text, fn })) };
}

/** Match repo migration files with the live migration log; flag hand-applied ones by their objects. */
export function compareMigrations(repo, live) {
  const liveList = live?.database?.migrations ?? [];
  const norm = (n) => n.replace(/^\d+_/, '');
  const used = new Set();
  const rows = repo.map((m) => {
    const hit = liveList.find((l, i) => !used.has(i) && norm(l.name) === m.name && (used.add(i), true));
    if (hit) return { ...m, live: 'applied', liveVersion: hit.version };
    // Not in the log: are its functions and tables there anyway (pasted into the SQL editor)?
    const objs = m.created.map((c) => c.split(':'));
    const present = objs.length && objs.every(([kind, name]) => (kind === 'function' ? live?.database?.functions?.[name] : live?.database?.tables?.[name]));
    return { ...m, live: present ? 'applied-by-hand' : 'not-applied' };
  });
  const liveOnly = liveList.filter((_, i) => !used.has(i)).map((l) => ({ version: l.version, name: l.name }));
  return { rows, liveOnly };
}

function liveModuleRoles(live, module) {
  const rows = live?.database?.role_permissions ?? [];
  const names = Object.fromEntries((live?.database?.team_roles ?? []).map((r) => [r.code, r.name]));
  const by = (action) => uniq(rows.filter((r) => r.module === module && r.action === action).map((r) => names[r.role] ?? r.role));
  return { view: by('view'), edit: by('edit'), approve: by('approve'), export: by('export'), names };
}

const plainList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Plain words for a table: its SQL comment's first sentence, else its name with spaces. */
export function tableLabel(schema, t) {
  const c = schema.tables[t]?.comment;
  return c ? `${t.replace(/_/g, ' ')} (${c.split(/(?<=\.)\s/)[0].replace(/\.$/, '')})` : t.replace(/_/g, ' ');
}

export function buildGraph(scan) {
  const { cfg, schema, web, edge, adrs, moduleDocs, patchDocs, securityChecks, pageTests, commits, live, annotations, troubleshooting, lock, moduleLabels } = scan;

  // ---------- features: one per screen, plus annotation-only ones (background jobs, infrastructure)
  const features = {};
  const idOf = (screenId) => screenId.replace(/#/g, '-').replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/-$/, '').toLowerCase();
  for (const s of web.screens) {
    const id = idOf(s.id);
    features[id] = { id, screens: [s.id] };
  }
  for (const a of Object.values(annotations)) {
    features[a.feature_id] ??= { id: a.feature_id, screens: [] };
    if (a.screens?.length) features[a.feature_id].screens = a.screens;
  }
  const screenById = Object.fromEntries(web.screens.map((s) => [s.id, s]));
  // A function called in most checks' setup (place_order…) says nothing about which feature a
  // check is for; a check counts for a feature when it calls a rarer function or names it.
  const sectionCount = {};
  for (const c of securityChecks) for (const n of c.functions) sectionCount[n] = (sectionCount[n] ?? 0) + 1;
  const setupFns = new Set(Object.keys(sectionCount).filter((n) => sectionCount[n] > securityChecks.length * 0.1));

  const liveFns = live?.database?.functions ?? {}, liveTables = live?.database?.tables ?? {};
  const deployed = new Set((live?.edge_functions ?? []).map((e) => e.slug));

  for (const f of Object.values(features)) {
    const a = annotations[f.id];
    const screens = f.screens.map((id) => screenById[id]).filter(Boolean);
    const first = screens[0];
    f.annotation = a ?? null;
    f.status = a ? a.status : 'none';
    f.infrastructure = !!a?.infrastructure;
    f.area = f.infrastructure ? 'infrastructure' : first ? (first.role === 'admin' ? 'admin' : first.id.startsWith('page#') ? 'page' : first.role) : 'jobs';
    f.module = a?.module ?? first?.module ?? (f.area === 'admin' ? 'other' : f.area);
    f.areaLabel = f.area === 'admin' ? 'Admin app' : AREA_LABEL[f.area] ?? f.area;
    f.moduleLabel = f.area === 'admin' ? (moduleLabels[f.module] ?? f.module) : f.areaLabel;
    f.name = a?.name ?? (first ? defaultName(first, moduleLabels) : f.id);
    f.route = first?.route ?? null;
    f.headerSummary = first?.summary ?? '';
    f.header = first?.header ?? '';
    f.role = first?.role ?? null;

    // Evidence: files, wrappers, functions, tables, buckets, Edge Functions.
    f.files = uniq([...screens.flatMap((s) => s.ownFiles), ...(a?.evidence?.files ?? [])]);
    f.wrappers = uniq(screens.flatMap((s) => s.apiCalls));
    const w = f.wrappers.map((n) => web.wrappers[n]).filter(Boolean);
    f.rpcs = uniq([...w.flatMap((x) => x.rpcs), ...(a?.evidence?.functions ?? [])]);
    f.directTables = {};
    for (const x of w) for (const [t, ops] of Object.entries(x.tables)) f.directTables[t] = uniq([...(f.directTables[t] ?? []), ...ops]);
    for (const t of a?.evidence?.tables ?? []) f.directTables[t] ??= ['select'];
    f.buckets = uniq([...w.flatMap((x) => x.storage), ...(a?.evidence?.buckets ?? [])]);
    f.edgeFunctions = uniq([...w.flatMap((x) => x.edge), ...(a?.evidence?.edge_functions ?? [])]);
    const edgeRpcs = f.edgeFunctions.flatMap((e) => edge[e]?.rpcs ?? []);
    const r = reach(schema, [...f.rpcs, ...edgeRpcs]);
    const direct = reach(schema, [...f.rpcs, ...edgeRpcs], { triggers: false });
    f.reach = r;
    f.tablesWritten = uniq([...r.writes, ...Object.entries(f.directTables).filter(([, ops]) => ops.some((o) => o !== 'select')).map(([t]) => t)]);
    f.tablesRead = uniq([...r.reads, ...Object.keys(f.directTables)]).filter((t) => !f.tablesWritten.includes(t));
    f.coreTables = uniq([...direct.reads, ...direct.writes, ...Object.keys(f.directTables)]).filter((t) => schema.tables[t]);
    f.migrations = uniq([
      ...f.coreTables.flatMap((t) => schema.tables[t]?.migrations ?? []),
      ...f.rpcs.flatMap((n) => schema.functions[n]?.migrations ?? []),
    ]);
    f.policies = Object.fromEntries(f.coreTables.filter((t) => schema.policies[t]).map((t) => [t, Object.values(schema.policies[t])]));

    // Production status from evidence.
    const missingFns = [...f.rpcs, ...edgeRpcs].filter((n) => !liveFns[n]);
    const missingTables = f.coreTables.filter((t) => schema.tables[t]?.kind === 'table' && !liveTables[t]);
    const missingEdge = f.edgeFunctions.filter((e) => !deployed.has(e));
    f.live = { missingFunctions: missingFns, missingTables, missingEdge,
      ready: !missingFns.length && !missingTables.length && !missingEdge.length };

    // Tests.
    f.pageTests = pageTests.filter((t) => screens.some((s) => coveredBy(t, s))).map((t) => t.name);
    f.securityChecks = securityChecks.filter((c) => f.rpcs.some((n) => c.text.includes(n) || (c.functions.includes(n) && !setupFns.has(n))))
      .map((c) => ({ id: c.id, text: c.text }));
    f.tested = f.pageTests.length > 0 || f.securityChecks.length > 0;

    // History and decisions.
    const evidenceFiles = new Set([...f.files, ...f.migrations.map((m) => `${cfg.paths.migrations}/${m}`), ...f.edgeFunctions.flatMap((e) => edge[e]?.files ?? [])]);
    f.commits = (commits ?? []).filter((c) => c.files.some((p) => evidenceFiles.has(p))).map((c) => c.short);
    const needles = [...f.rpcs.map((n) => `${n}(`), ...f.files.map((p) => p.split('/').pop()), ...(f.route && f.route.startsWith('#') ? [`${f.route}`] : [])];
    f.adrs = adrs.map((d) => ({ id: d.id, n: needles.filter((x) => d.text.includes(x)).length })).filter((x) => x.n).sort((x, y) => y.n - x.n).slice(0, 6).map((x) => x.id);
    f.docs = moduleDocs.filter((d) => needles.some((x) => d.text.includes(x))).map((d) => d.file);

    // Common errors: the catalog entries that name this feature + the database's own messages.
    f.troubleshooting = troubleshooting.filter((e) => e.features.includes(f.id)).map((e) => e.id);
  }

  // ---------- staleness
  const evidenceOf = (f) => {
    const ev = {};
    for (const p of f.files) ev[p] = web.modules[p]?.hash ?? 'missing';
    for (const n of f.wrappers) ev[`api.js#${n}`] = web.wrappers[n]?.hash ?? 'missing';
    for (const n of f.reach.functions) ev[`function:${n}`] = schema.functions[n]?.bodyHash ?? 'missing';
    for (const t of f.coreTables) ev[`table:${t}`] = sha(JSON.stringify([schema.tables[t].migrations, schema.tables[t].columns]));
    for (const e of f.edgeFunctions) ev[`edge:${e}`] = edge[e]?.hash ?? 'missing';
    return ev;
  };
  for (const f of Object.values(features)) {
    f.evidence = evidenceOf(f);
    const locked = lock[f.id];
    f.stale = [];
    if (f.status === 'reviewed') {
      if (!locked) f.stale.push({ key: '(no review record)', why: 'The annotation says reviewed but appatlas/review-lock.json has no record; run appatlas review again.' });
      else for (const k of uniq([...Object.keys(locked.evidence), ...Object.keys(f.evidence)])) {
        if (locked.evidence[k] !== f.evidence[k]) f.stale.push({ key: k, why: explainChange(k, locked.evidence[k], f.evidence[k], schema) });
      }
    }
    f.confidence = f.stale.length ? 'stale' : f.status === 'reviewed' ? 'reviewed' : f.status === 'draft' ? 'draft' : 'none';
  }

  // ---------- the 10 answers
  for (const f of Object.values(features)) f.answers = answer(f, { schema, live, troubleshooting, moduleLabels, friendlyErrors: web.friendlyErrors ?? [] });

  // ---------- reverse indexes for the impact estimator
  const usedBy = { table: {}, function: {}, file: {}, wrapper: {}, edge: {}, bucket: {} };
  const add = (kind, key, id) => { (usedBy[kind][key] ||= new Set()).add(id); };
  for (const f of Object.values(features)) {
    [...f.tablesWritten, ...f.tablesRead].forEach((t) => add('table', t, f.id));
    f.reach.functions.forEach((n) => add('function', n, f.id));
    f.files.forEach((p) => add('file', p, f.id));
    f.wrappers.forEach((n) => add('wrapper', n, f.id));
    f.edgeFunctions.forEach((e) => add('edge', e, f.id));
    f.buckets.forEach((b) => add('bucket', b, f.id));
  }
  const usedByOut = Object.fromEntries(Object.entries(usedBy).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).map(([x, s]) => [x, [...s].sort()]))]));

  return { features, usedBy: usedByOut };
}

function defaultName(screen, moduleLabels) {
  if (screen.id.startsWith('page#')) return `${screen.id.slice(5).replace(/^\w/, (c) => c.toUpperCase())} page`;
  if (screen.id === 'delivery#app') return 'Driver app';
  if (screen.id === 'restaurant#cart') return 'Cart & checkout';
  const r = screen.route.replace(/^#/, '').replace(/[-/]/g, ' ');
  return r.replace(/^\w/, (c) => c.toUpperCase());
}

/** Does a page test exercise this screen? (opens its app at its route, or loads its page module) */
export function coveredBy(test, screen) {
  if (screen.main) {
    if (!test.mains.includes(screen.main)) return false;
    if (screen.shellOnly) return /cart|checkout|place/i.test(test.name);
    return test.routes.includes(screen.route.replace(/\/$/, '')) || (screen.isDefault && test.routes.length === 0);
  }
  return test.mains.includes(screen.file);
}

function explainChange(key, before, after, schema) {
  if (before === undefined) return `${key} is new: the feature now depends on it.`;
  if (after === undefined) return `${key} is no longer used by this feature.`;
  if (key.startsWith('table:')) { const t = key.slice(6); return `Table ${t} changed: it is now touched by ${schema.tables[t]?.migrations.at(-1) ?? 'a newer migration'}.`; }
  if (key.startsWith('function:')) { const n = key.slice(9); return `Database function ${n}() was redefined (now in ${schema.functions[n]?.definedIn ?? '?'}).`; }
  if (key.startsWith('api.js#')) return `The api.js wrapper ${key.slice(7)}() changed.`;
  if (key.startsWith('edge:')) return `Edge Function ${key.slice(5)} changed.`;
  return `${key} changed.`;
}

function fromAnnotation(f, key) {
  const v = f.annotation?.admin?.[key];
  if (v === undefined || v === null || (Array.isArray(v) && !v.length) || v === '') return null;
  const src = f.confidence === 'stale' ? 'stale' : f.status === 'reviewed' ? 'annotation' : 'draft';
  return { value: v, source: src };
}

/** What the Postgres codes that api.js translates mean in practice (PostgreSQL error code list). */
const PG_CODE = {
  23505: 'Another row already has this value (a code, SKU or name must be unique). Use a different one.',
  23503: 'Other records still point at this one, so it cannot be removed. Switch it off instead of deleting it.',
  42501: 'Your team role does not allow this change (Settings → Roles), or the row is outside your city / warehouse.',
};

function answer(f, { schema, live, troubleshooting, moduleLabels, friendlyErrors }) {
  const out = {};
  for (const { key, q } of QUESTIONS) {
    const parts = [];
    const ann = fromAnnotation(f, key);
    if (key === 'what_is_this') {
      if (ann) parts.push(ann);
      else if (f.headerSummary) parts.push({ value: f.headerSummary.replace(/^\w/, (c) => c.toUpperCase()), source: 'code comment' });
    } else if (key === 'who_uses_it') {
      const perm = whoFacts(f, live, moduleLabels);
      if (perm) parts.push({ value: perm, source: 'permissions' });
      if (ann) parts.push(ann);
    } else if (key === 'what_does_it_affect') {
      if (ann) parts.push(ann);
      const lines = [];
      if (f.tablesWritten.length) lines.push(`Changes: ${plainList(f.tablesWritten.filter((t) => t !== 'audit_log').map((t) => tableLabel(schema, t)))}.`);
      if (f.tablesWritten.includes('audit_log')) lines.push('Every change is recorded in the audit log (Settings → Audit log).');
      if (f.edgeFunctions.length) lines.push(`Runs on the server: ${f.edgeFunctions.join(', ')} (Edge Function).`);
      if (f.buckets.length) lines.push(`Stores files in: ${f.buckets.join(', ')}.`);
      if (!lines.length && f.tablesRead.length) lines.push(`Only reads: ${plainList(f.tablesRead.slice(0, 8).map((t) => t.replace(/_/g, ' ')))}${f.tablesRead.length > 8 ? ' and more' : ''}. It changes nothing.`);
      if (lines.length) parts.push({ value: lines.join(' '), source: 'graph' });
    } else if (key === 'common_errors') {
      if (ann) parts.push(ann);
      const cat = troubleshooting.filter((e) => f.troubleshooting.includes(e.id)).map((e) => ({ symptom: e.symptom, solution: `${e.cause} ${e.fix}`.trim() }));
      if (cat.length) parts.push({ value: cat, source: 'troubleshooting' });
      const db = f.reach.errors.slice(0, 25)
        .map((e) => ({ symptom: e.text, solution: `Message from the database (${e.fn}). It names what to fix.` }));
      if (db.length) parts.push({ value: db, source: 'database' });
      // Screens that write tables directly get api.js friendlyMessage() texts for refused writes.
      if (Object.values(f.directTables).some((ops) => ops.some((o) => o !== 'select')) && friendlyErrors.length) {
        parts.push({ value: friendlyErrors.map((e) => ({ symptom: e.text, solution: PG_CODE[e.code] ?? `Database error code ${e.code}.` })), source: 'database' });
      }
    } else if (ann) {
      parts.push(ann);
    }
    out[key] = { q, parts, missing: parts.length === 0 };
  }
  return out;
}

function whoFacts(f, live, moduleLabels) {
  if (f.area === 'admin' && f.module && moduleLabels[f.module]) {
    const r = liveModuleRoles(live, f.module);
    const s = [`Team members whose role may view ${moduleLabels[f.module]}: Super admin${r.view.length ? `, ${r.view.join(', ')}` : ' only'}.`];
    if (r.edit.length) s.push(`May change things here: Super admin, ${r.edit.join(', ')}.`);
    if (r.approve.length) s.push(`May approve: Super admin, ${r.approve.join(', ')}.`);
    if (f.reach.permissions.length) s.push(`The database also checks: ${f.reach.permissions.map((p) => p.replace(':', ' → ')).join(', ')}.`);
    return s.join(' ');
  }
  if (f.area === 'restaurant') return 'Customers signed in to the customer app (the account owner and the members they invite; what a member may do depends on their customer role).';
  if (f.area === 'delivery') return 'Drivers signed in to the driver app; they see only the orders assigned to them.';
  if (f.route === 'web/index.html' || f.id === 'page-page') return 'Anyone on the public website; no sign-in needed.';
  if (f.reach.permissions.length) return `The database checks: ${f.reach.permissions.map((p) => p.replace(':', ' → ')).join(', ')}.`;
  return null;
}

export { liveModuleRoles, plainList };
