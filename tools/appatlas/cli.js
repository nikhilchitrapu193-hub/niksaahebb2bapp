#!/usr/bin/env node
// =============================================================================
// cli.js — AppAtlas command line. Run from the repository root:
//
//   node tools/appatlas/cli.js build              scan + write appatlas/out/ (site, JSON, Markdown)
//   node tools/appatlas/cli.js check              exit 1 if an annotation is stale or invalid (CI)
//   node tools/appatlas/cli.js list               every feature id with its screen and status
//   node tools/appatlas/cli.js annotate [id]      write draft YAML for features that have none
//        --interactive                            …asking the questions one by one
//   node tools/appatlas/cli.js review <id> --by "Name"   a person confirms an annotation
//   node tools/appatlas/cli.js impact --table orders | --function place_order | --feature admin-orders | --file <path>
//   node tools/appatlas/cli.js diff --since <tag|commit>  features touched since a release
//   node tools/appatlas/cli.js onboard --role city_manager   onboarding checklist (Markdown)
//   node tools/appatlas/cli.js migration-guide    "how to move off Supabase" for this app
//   node tools/appatlas/cli.js export --format md|json|html
//   node tools/appatlas/cli.js serve [--port 4000]
//   node tools/appatlas/cli.js watch              rebuild when web/, supabase/ or annotations change
//
// npm scripts: `npm run atlas` (build) and `npm run atlas:check`.
// Deterministic: no network, no AI, no clock in the output (ADR 0026).
// =============================================================================

import { mkdirSync, writeFileSync, readFileSync, existsSync, watch } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { build, loadConfig } from './lib/build.js';
import { renderSite } from './lib/site.js';
import { writeMarkdown, onboardingMarkdown, migrationGuideMarkdown, featureMarkdown } from './lib/export-md.js';
import { stringify, parse } from './lib/yaml.js';
import { QUESTIONS } from './lib/annotations.js';
import { changedSince } from './lib/scan-other.js';
import { readText } from './lib/text.js';

const root = process.cwd();
const [command = 'help', ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i === -1 ? undefined : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true); };
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--interactive'));

function fail(message) { console.error(`appatlas: ${message}`); process.exit(1); }

function writeOut(k, formats = ['html', 'json', 'md']) {
  const cfg = loadConfig(root);
  const out = join(root, cfg.out_dir);
  mkdirSync(out, { recursive: true });
  if (formats.includes('json')) writeFileSync(join(out, 'knowledge-graph.json'), `${JSON.stringify(k, null, 1)}\n`);
  if (formats.includes('html')) {
    writeFileSync(join(out, 'index.html'), renderSite(k, { root, cfg }));
    writeFileSync(join(out, 'appatlas-artifact.html'), renderSite(k, { root, cfg, fragment: true }));
  }
  if (formats.includes('md')) writeMarkdown(k, join(out, 'md'));
  return out;
}

function summary(k) {
  const h = k.health;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  console.log(`AppAtlas · ${k.project.name}`);
  console.log(`  features ${h.features} · reviewed ${h.reviewed} · draft ${h.draft} · stale ${h.stale.length} · no annotation ${h.unannotated.length}`);
  console.log(`  admin answers filled ${h.answersFilled}/${h.answersTotal} (${pct(h.answersFilled, h.answersTotal)}%) · untested ${h.untested.length} · not ready in production ${h.notReadyLive.length}`);
  const m = k.repoVsLive.migrations.rows;
  console.log(`  migrations: ${m.length} in repo · ${m.filter((r) => r.live === 'applied').length} applied · ${m.filter((r) => r.live === 'applied-by-hand').length} applied by hand · ${m.filter((r) => r.live === 'not-applied').length} not applied · ${k.repoVsLive.migrations.liveOnly.length} live-only`);
  for (const e of [...h.annotationErrors, ...h.troubleErrors]) console.log(`  ERROR ${e}`);
}

function findFeature(k, id) {
  const f = k.features[id];
  if (!f) fail(`no feature "${id}". Run: node tools/appatlas/cli.js list`);
  return f;
}

async function main() {
  switch (command) {
    case 'build': case 'init': {
      const k = build(root);
      const out = writeOut(k);
      summary(k);
      console.log(`  wrote ${out}/index.html, knowledge-graph.json, md/`);
      if (k.health.annotationErrors.length || k.health.troubleErrors.length) process.exit(1);
      break;
    }
    case 'check': {
      const k = build(root);
      summary(k);
      for (const id of k.health.stale) {
        console.log(`  STALE ${id}`);
        for (const s of k.features[id].stale) console.log(`        ${s.why}`);
      }
      const bad = k.health.stale.length + k.health.annotationErrors.length + k.health.troubleErrors.length;
      if (bad) { console.log('  Review the features above, then: node tools/appatlas/cli.js review <id> --by "Your name"'); process.exit(1); }
      console.log('  OK: no stale or invalid annotations.');
      break;
    }
    case 'list': {
      const k = build(root, { git: false });
      for (const f of Object.values(k.features).sort((a, b) => a.id.localeCompare(b.id))) {
        console.log(`${f.id.padEnd(30)} ${(f.screens[0] ?? '-').padEnd(26)} ${f.confidence}`);
      }
      break;
    }
    case 'annotate': {
      const k = build(root, { git: false });
      const cfg = loadConfig(root);
      const ids = positional.length ? positional : Object.values(k.features).filter((f) => f.status === 'none').map((f) => f.id);
      const rl = flag('interactive') ? createInterface({ input: process.stdin, output: process.stdout }) : null;
      for (const id of ids) {
        const f = findFeature(k, id);
        const file = join(root, cfg.annotation_dir, `${id}.yaml`);
        if (existsSync(file) && !rl) { console.log(`  skip ${id}: ${cfg.annotation_dir}/${id}.yaml exists`); continue; }
        const existing = existsSync(file) ? parse(readText(file)) : null;
        const admin = { ...(existing?.admin ?? {}) };
        if (rl) {
          console.log(`\n${f.name} (${f.screens.join(', ') || 'no screen'}). Enter keeps the current answer; "-" clears it.`);
          for (const { key, q } of QUESTIONS) {
            if (['who_uses_it', 'what_does_it_affect'].includes(key)) continue;   // read from the code
            if (key === 'workflow' || key === 'common_errors') continue;          // edit these in the file
            const now = admin[key] ? ` [${String(admin[key]).slice(0, 60)}]` : '';
            const a = (await rl.question(`  ${q}${now}\n  > `)).trim();
            if (a === '-') delete admin[key]; else if (a) admin[key] = a;
          }
        }
        const doc = {
          feature_id: id, name: existing?.name ?? f.name, module: existing?.module ?? f.module, status: 'draft',
          drafted_by: rl ? 'appatlas annotate --interactive' : 'appatlas annotate (skeleton)',
          screens: f.screens, admin: Object.keys(admin).length ? admin : { what_is_this: f.headerSummary || '' },
        };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `# ${id}.yaml — admin guide for "${doc.name}". Draft until a person runs: appatlas review ${id} --by "Name"\n${stringify(doc)}`);
        console.log(`  wrote ${cfg.annotation_dir}/${id}.yaml`);
      }
      rl?.close();
      break;
    }
    case 'review': {
      const id = positional[0] ?? fail('usage: review <feature-id> --by "Your name"');
      const by = flag('by');
      if (typeof by !== 'string') fail('say who reviewed it: --by "Your name"');
      const k = build(root, { git: false });
      const f = findFeature(k, id);
      const cfg = loadConfig(root);
      const file = join(root, cfg.annotation_dir, `${id}.yaml`);
      if (!existsSync(file)) fail(`${cfg.annotation_dir}/${id}.yaml does not exist; run annotate ${id} first`);
      const date = flag('date') ?? new Date().toISOString().slice(0, 10);
      const text = readText(file);
      const doc = parse(text);
      doc.status = 'reviewed'; doc.reviewed_by = by; doc.reviewed_on = date;
      const head = text.split('\n').filter((l) => l.startsWith('#')).join('\n');
      writeFileSync(file, `${head ? `${head}\n` : ''}${stringify(doc)}`);
      const lockFile = join(root, cfg.review_lock);
      const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
      lock[id] = { reviewed_by: by, reviewed_on: date, evidence: f.evidence };
      const sorted = Object.fromEntries(Object.keys(lock).sort().map((x) => [x, lock[x]]));
      writeFileSync(lockFile, `${JSON.stringify(sorted, null, 1)}\n`);
      console.log(`  ${id} reviewed by ${by} on ${date}; ${Object.keys(f.evidence).length} pieces of evidence recorded in ${cfg.review_lock}`);
      break;
    }
    case 'impact': {
      const k = build(root, { git: false });
      const kinds = { table: 'table', function: 'function', file: 'file', wrapper: 'wrapper', edge: 'edge', bucket: 'bucket' };
      let ids;
      if (flag('feature')) {
        const f = findFeature(k, flag('feature'));
        console.log(`${f.name}: writes ${f.tablesWritten.join(', ') || 'nothing'}; reads ${f.tablesRead.join(', ') || 'nothing'}`);
        // audit_log is written by every change (a trigger), so it says nothing about impact.
        ids = [...new Set(f.tablesWritten.filter((t) => t !== 'audit_log').flatMap((t) => k.usedBy.table[t] ?? []))].filter((x) => x !== f.id);
        console.log(`Features that read or write the same tables (would see its changes): ${ids.length}`);
      } else {
        const kind = Object.keys(kinds).find((x) => flag(x));
        if (!kind) fail('usage: impact --table <name> | --function <name> | --feature <id> | --file <path> | --wrapper <name> | --edge <name> | --bucket <name>');
        ids = k.usedBy[kind][flag(kind)] ?? [];
        console.log(`${kind} ${flag(kind)} is used by ${ids.length} feature(s):`);
      }
      for (const id of ids.sort()) console.log(`  ${id.padEnd(30)} ${k.features[id].name}`);
      break;
    }
    case 'diff': {
      const since = flag('since');
      if (typeof since !== 'string') fail('usage: diff --since <tag or commit>');
      let files;
      try { files = new Set(changedSince(root, since)); } catch { fail(`git could not compare with "${since}"`); }
      const k = build(root, { git: false });
      const cfg = loadConfig(root);
      const hit = Object.values(k.features).filter((f) => [...f.files, ...f.migrations.map((m) => `${cfg.paths.migrations}/${m}`)].some((p) => files.has(p)));
      console.log(`${files.size} file(s) changed since ${since}; ${hit.length} feature(s) touched:`);
      for (const f of hit) console.log(`  ${f.id.padEnd(30)} ${f.name}`);
      if (files.has('web/js/core/api.js')) console.log('  (api.js changed: run `check` after reviewing to see which wrappers moved)');
      break;
    }
    case 'onboard': {
      const k = build(root, { git: false });
      const role = flag('role');
      if (typeof role !== 'string' || !k.onboarding[role]) fail(`usage: onboard --role <${Object.keys(k.onboarding).join(' | ')}>`);
      process.stdout.write(onboardingMarkdown(k, role));
      break;
    }
    case 'migration-guide': {
      process.stdout.write(migrationGuideMarkdown(build(root, { git: false })));
      break;
    }
    case 'export': {
      const format = flag('format') ?? 'html';
      if (format === 'pdf') fail('PDF is not built in: AppAtlas has no dependencies and no browser. Open appatlas/out/index.html and use the browser\'s Print → Save as PDF on the Admin manual page, or convert md/admin-manual.md with any Markdown tool.');
      if (!['md', 'json', 'html'].includes(format)) fail('format must be md, json or html');
      const out = writeOut(build(root), [format]);
      console.log(`  wrote ${format} to ${out}`);
      break;
    }
    case 'feature': {
      const k = build(root, { git: false });
      process.stdout.write(featureMarkdown(k, findFeature(k, positional[0])));
      break;
    }
    case 'serve': {
      const cfg = loadConfig(root);
      const out = writeOut(build(root));
      const port = Number(flag('port') ?? 4000);
      createServer((req, res) => {
        const path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
        const file = resolve(out, `.${path}`);
        if (!file.startsWith(resolve(out)) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json' : 'text/plain';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
        res.end(readFileSync(file));
      }).listen(port, () => console.log(`AppAtlas at http://localhost:${port} (from ${cfg.out_dir}; Ctrl+C to stop)`));
      break;
    }
    case 'watch': {
      const cfg = loadConfig(root);
      let timer = null;
      const rebuild = () => { try { const k = build(root); writeOut(k); summary(k); } catch (e) { console.error(e.message); } };
      rebuild();
      for (const dir of ['web/js', cfg.paths.migrations, cfg.paths.functions, cfg.annotation_dir, 'docs']) {
        if (!existsSync(join(root, dir))) continue;
        watch(join(root, dir), { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(rebuild, 300); });
      }
      console.log('Watching web/js, supabase/, docs/ and annotations. Ctrl+C to stop.');
      break;
    }
    default:
      console.log(readText(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).split('\n').filter((l) => l.startsWith('//   ') || l.startsWith('//        ')).map((l) => l.slice(3)).join('\n'));
  }
}

main().catch((e) => fail(e.stack ?? e.message));
