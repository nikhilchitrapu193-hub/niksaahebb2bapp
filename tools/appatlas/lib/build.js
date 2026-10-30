// =============================================================================
// build.js — runs every scanner and returns the whole knowledge base as one
// plain object (written out as appatlas/out/knowledge-graph.json). Everything
// the website, the Markdown export and the CLI commands show comes from here.
// Same repository in → same JSON out: no clock, no network, no AI (ADR 0026).
// The only date in the output is the one stored in live-state.json.
// =============================================================================

import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { parse } from './yaml.js';
import { readText, walk, uniq } from './text.js';
import { buildSchema, readMigrations, scanSecurityTests } from './scan-sql.js';
import { scanWeb, importCycles, unusedExports } from './scan-web.js';
import { scanEdgeFunctions, scanAdrs, scanDocs, scanPageTests, gitLog } from './scan-other.js';
import { loadAnnotations, loadTroubleshooting, loadLock, QUESTIONS } from './annotations.js';
import { buildGraph, compareMigrations, liveModuleRoles, DOC_REQUIRED } from './graph.js';

export function loadConfig(root) {
  const file = join(root, 'appatlas/appatlas.yaml');
  if (!existsSync(file)) throw new Error('appatlas/appatlas.yaml not found. Run AppAtlas from the repository root.');
  return parse(readText(file));
}

function moduleLabelsFrom(configJs) {
  const block = (/export const MODULES = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(configJs) || [, ''])[1];
  return Object.fromEntries([...block.matchAll(/(\w+)\s*:\s*\{\s*label:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
}

/** Ingestion: what kind of app is this? Only facts that can be read from files. */
function discover(root) {
  const files = walk(root, ['node_modules', '.git', 'vendor', 'out']);
  const ext = {};
  for (const f of files) { const e = (/\.([a-z0-9]+)$/i.exec(f) || [, 'none'])[1].toLowerCase(); ext[e] = (ext[e] ?? 0) + 1; }
  const pkg = existsSync(join(root, 'package.json')) ? JSON.parse(readText(join(root, 'package.json'))) : {};
  return {
    files: files.length,
    languages: Object.entries(ext).filter(([e]) => ['js', 'ts', 'sql', 'html', 'css', 'md', 'yaml', 'json'].includes(e)).sort((a, b) => b[1] - a[1]),
    framework: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /react|vue|svelte|angular|next/.test(d)) ? 'framework' : 'none (plain ES modules)',
    infrastructure: existsSync(join(root, 'supabase')) ? 'supabase' : 'unknown',
    runtimeDependencies: Object.keys(pkg.dependencies ?? {}),
    devDependencies: Object.keys(pkg.devDependencies ?? {}),
  };
}

export function build(root, { git = true } = {}) {
  const cfg = loadConfig(root);
  const P = cfg.paths;
  const migrationFiles = existsSync(join(root, P.migrations)) ? readdirSync(join(root, P.migrations)).map((f) => join(root, P.migrations, f)) : [];
  const schema = buildSchema(readMigrations(migrationFiles));
  const web = scanWeb(root, cfg);
  const edge = scanEdgeFunctions(root, P.functions);
  const adrs = scanAdrs(root, P.adr);
  const moduleDocs = scanDocs(root, P.module_docs);
  const patchDocs = scanDocs(root, P.patch_docs);
  const securityChecks = scanSecurityTests(readText(join(root, P.security_test)));
  const pageTestText = readText(join(root, P.page_tests));
  const pageTests = scanPageTests(pageTestText);
  const commits = git ? gitLog(root) : null;
  const liveText = readText(join(root, cfg.live_state));
  const live = liveText ? JSON.parse(liveText) : null;
  const { annotations, errors: annotationErrors } = loadAnnotations(root, cfg.annotation_dir);
  const { entries: troubleshooting, errors: troubleErrors } = loadTroubleshooting(root, cfg.troubleshooting);
  const lock = loadLock(root, cfg.review_lock);
  const moduleLabels = moduleLabelsFrom(readText(join(root, P.config_js)));

  const { features, usedBy } = buildGraph({ cfg, schema, web, edge, adrs, moduleDocs, patchDocs, securityChecks, pageTests, commits, live, annotations, troubleshooting, lock, moduleLabels });

  // Annotations that point at screens or features that no longer exist.
  const screenIds = new Set(web.screens.map((s) => s.id));
  for (const a of Object.values(annotations)) for (const s of a.screens ?? []) if (!screenIds.has(s)) annotationErrors.push(`${a.file}: screen "${s}" does not exist (routes are listed by appatlas list)`);
  for (const e of troubleshooting) for (const id of e.features) if (!features[id]) troubleErrors.push(`${cfg.troubleshooting}: entry "${e.id}" names unknown feature "${id}"`);

  // ---------- repo vs live
  const migrations = compareMigrations(schema.migrations, live);
  const liveFns = live?.database?.functions ?? {}, liveTables = live?.database?.tables ?? {};
  const liveEdge = new Set((live?.edge_functions ?? []).map((e) => e.slug));
  const rpcCalls = uniq(Object.values(web.wrappers).flatMap((w) => w.rpcs));
  const repoVsLive = {
    migrations,
    functionsNotLive: Object.keys(schema.functions).filter((n) => !liveFns[n] && !schema.functions[n].droppedIn),
    functionsLiveOnly: Object.keys(liveFns).filter((n) => !schema.functions[n]),
    tablesNotLive: Object.keys(schema.tables).filter((t) => schema.tables[t].kind === 'table' && !liveTables[t]),
    tablesLiveOnly: Object.keys(liveTables).filter((t) => !schema.tables[t]),
    tablesWithoutRls: Object.entries(liveTables).filter(([, v]) => !v.rls).map(([t]) => t),
    definerWithoutSearchPath: Object.entries(liveFns).filter(([, v]) => v.security_definer && !v.search_path_set).map(([n]) => n),
    rpcCalledButNotLive: rpcCalls.filter((n) => !liveFns[n]),
    edge: Object.keys(edge).map((name) => ({ name, deployed: liveEdge.has(name), calledFromWeb: Object.values(web.wrappers).some((w) => w.edge.includes(name)) })),
    edgeLiveOnly: [...liveEdge].filter((e) => !edge[e]),
    bucketsNotLive: Object.keys(schema.buckets).filter((b) => !(live?.database?.buckets ?? []).some((x) => x.id === b)),
    liveGenerated: live?.database?.generated ?? null,
    edgeChecked: live?.edge_functions_checked ?? null,
  };

  // ---------- health
  const list = Object.values(features);
  const answered = (f) => QUESTIONS.filter((q) => !f.answers[q.key].missing).length;
  const health = {
    features: list.length,
    reviewed: list.filter((f) => f.confidence === 'reviewed').length,
    draft: list.filter((f) => f.confidence === 'draft').length,
    stale: list.filter((f) => f.confidence === 'stale').map((f) => f.id),
    unannotated: list.filter((f) => f.status === 'none').map((f) => f.id),
    answersFilled: list.reduce((n, f) => n + answered(f), 0),
    answersTotal: list.length * QUESTIONS.length,
    untested: list.filter((f) => !f.tested && !f.infrastructure).map((f) => f.id),
    notReadyLive: list.filter((f) => !f.live.ready).map((f) => f.id),
    annotationErrors, troubleErrors,
    importCycles: importCycles(web.modules),
    unusedExports: unusedExports(web.modules, readText(join(root, P.unit_tests)) + pageTestText),
    filesWithoutHeader: Object.values(web.modules).filter((m) => !m.hasHeader).map((m) => m.path),
    largeScreens: Object.values(web.modules).filter((m) => /\/pages\//.test(m.path) && m.lines > 250).map((m) => ({ file: m.path, lines: m.lines })),
    gitAvailable: commits !== null,
  };

  // ---------- onboarding: per team role, the screens their permissions open, in menu order
  const teamRoles = live?.database?.team_roles ?? [];
  const onboarding = {};
  for (const r of teamRoles) {
    const mods = r.code === 'super_admin' ? Object.keys(moduleLabels)
      : uniq((live.database.role_permissions ?? []).filter((p) => p.role === r.code && p.action === 'view').map((p) => p.module));
    onboarding[r.code] = { name: r.name, description: r.description,
      features: list.filter((f) => f.area === 'admin' && mods.includes(f.module)).map((f) => f.id) };
  }
  onboarding.customer = { name: 'Customer (restaurant / outlet)', description: 'Orders, pays and asks for help in the customer app.', features: list.filter((f) => f.area === 'restaurant').map((f) => f.id) };
  onboarding.driver_app = { name: 'Driver (delivery app)', description: 'Delivers orders and collects cash on delivery.', features: list.filter((f) => f.area === 'delivery').map((f) => f.id) };

  // ---------- infrastructure facts for the migration guide (counted, not estimated)
  const sqlUsingAuth = Object.values(schema.functions).filter((f) => f.usesAuthUid && !f.legacy).map((f) => f.name);
  const infra = {
    auth: { files: Object.values(web.modules).filter((m) => /supabase\.auth|from '\.\/auth\.js'|requireRole/.test(readText(join(root, m.path))) && m.path.includes('/core/')).map((m) => m.path),
      wrappersUsingAuth: Object.values(web.wrappers).filter((w) => w.auth).map((w) => w.name), sqlFunctionsUsingAuthUid: sqlUsingAuth,
      edgeFunctions: Object.values(edge).filter((e) => e.usesServiceRole && /auth\.admin|inviteUser|generateLink|updateUserById/.test(readText(join(root, e.files[0])))).map((e) => e.name) },
    postgres: { tables: Object.keys(schema.tables).length, functions: Object.keys(schema.functions).length, definer: Object.values(schema.functions).filter((f) => f.securityDefiner).length,
      policies: Object.values(schema.policies).reduce((n, p) => n + Object.keys(p).length, 0), triggers: schema.triggers.length, migrations: schema.migrations.length },
    storage: { buckets: Object.values(schema.buckets), wrappers: Object.values(web.wrappers).filter((w) => w.storage.length).map((w) => ({ name: w.name, buckets: w.storage })) },
    edge: Object.values(edge).map((e) => ({ name: e.name, secrets: e.secrets, hosts: e.hosts, rpcs: e.rpcs, deployed: liveEdge.has(e.name) })),
  };

  return {
    project: { name: cfg.project_name, app_type: cfg.app_type, infrastructure: cfg.infrastructure, live: live?.project ?? null, discovery: discover(root) },
    questions: QUESTIONS, docRequired: DOC_REQUIRED, moduleLabels,
    features, usedBy,
    screens: web.screens.map(({ header, ...s }) => s),
    wrappers: web.wrappers, modules: Object.fromEntries(Object.entries(web.modules).map(([k, m]) => [k, { ...m, header: undefined }])),
    schema: { tables: schema.tables, functions: schema.functions, policies: schema.policies, triggers: schema.triggers, buckets: schema.buckets, migrations: schema.migrations },
    live, repoVsLive, edge, adrs: adrs.map(({ text, ...a }) => a), moduleDocs: moduleDocs.map(({ text, ...d }) => d), patchDocs: patchDocs.map(({ text, ...d }) => d),
    securityChecks, pageTests, commits: commits ?? [], troubleshooting, health, onboarding, infra,
    teamRoles, roleMatrix: Object.fromEntries(Object.keys(moduleLabels).map((m) => [m, liveModuleRoles(live, m)])),
  };
}
