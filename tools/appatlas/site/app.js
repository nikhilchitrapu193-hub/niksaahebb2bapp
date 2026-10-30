// =============================================================================
// app.js — the AppAtlas website (inlined into one HTML file by lib/site.js).
//
// Reads the knowledge base from <script id="atlas-data"> and renders views by
// URL hash (#home, #f-admin-orders, #t-orders …). Admin mode shows the 10 plain
// questions; Developer mode shows files, functions, tables, tests and history.
// Every value from the data goes through the escaping `html` template, the same
// rule as web/js/core/ui.js. Nothing is fetched; nothing is computed with AI.
// localStorage only remembers the mode (wrapped in try/catch: it can be blocked).
// =============================================================================

const K = JSON.parse(document.getElementById('atlas-data').textContent);

// ---------- escaping template (mirrors web/js/core/ui.js) --------------------
class Safe { constructor(v) { this.v = v; } toString() { return this.v; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const out = (v) => (v instanceof Safe ? v.v : Array.isArray(v) ? v.map(out).join('') : v === null || v === undefined || v === false ? '' : esc(v));
function html(strings, ...values) { let s = strings[0]; values.forEach((v, i) => { s += out(v) + strings[i + 1]; }); return new Safe(s); }
const $ = (s, r = document) => r.querySelector(s);
const store = {
  get(k, d) { try { return localStorage.getItem(`atlas.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`atlas.${k}`, v); } catch { /* storage blocked: the mode just isn't remembered */ } },
};

// ---------- lookups ----------------------------------------------------------
const FEATURES = Object.values(K.features).sort((a, b) => AREA_ORDER(a) - AREA_ORDER(b) || a.moduleLabel.localeCompare(b.moduleLabel) || a.name.localeCompare(b.name));
function AREA_ORDER(f) { return { admin: 0, restaurant: 1, delivery: 2, page: 3, jobs: 4, infrastructure: 5 }[f.area] ?? 6; }
const groupKey = (f) => (f.area === 'admin' ? f.module : f.area);
const GROUPS = [];
for (const f of FEATURES) { const k = groupKey(f); let g = GROUPS.find((x) => x.key === k); if (!g) GROUPS.push(g = { key: k, label: f.area === 'admin' ? f.moduleLabel : f.areaLabel, area: f.area, items: [] }); g.items.push(f); }
const slug = (n) => n.replace(/_/g, '-');
const bySlug = (obj) => Object.fromEntries(Object.keys(obj).map((n) => [slug(n), n]));
const TABLE = bySlug(K.schema.tables), FN = bySlug(K.schema.functions), ROLE = bySlug(K.onboarding);
const tLink = (t) => (K.schema.tables[t] ? html`<a class="chip" href="#t-${slug(t)}">${t}</a>` : html`<span class="chip">${t}</span>`);
const fLink = (n) => (K.schema.functions[n] ? html`<a class="chip" href="#fn-${slug(n)}">${n}()</a>` : html`<span class="chip w">${n}()</span>`);
const featLink = (id) => html`<a href="#f-${id}">${K.features[id]?.name ?? id}</a>`;
const COMMIT_FEATURES = {};
for (const f of FEATURES) for (const c of f.commits) (COMMIT_FEATURES[c] ||= []).push(f.id);

const SRC = {
  annotation: ['Reviewed', 'b-ok', 'A person wrote this and checked it against the app.'],
  draft: ['Draft', 'b-draft', 'Written at setup and not yet checked by a person. Treat with care.'],
  stale: ['Review needed', 'b-warn', 'This was reviewed, but the code it describes has changed since.'],
  'code comment': ['From code comment', 'b-info', 'The developer\'s description at the top of the screen\'s file.'],
  permissions: ['Verified · live permissions', 'b-ok', 'Read from the live role and permission settings.'],
  graph: ['Verified · database', 'b-ok', 'Worked out from the database functions this screen calls.'],
  database: ['Verified · database', 'b-ok', 'The exact messages the database shows when it refuses something.'],
  troubleshooting: ['Troubleshooting catalog', 'b-info', 'From appatlas/troubleshooting.yaml.'],
};
const CONF = {
  reviewed: ['Reviewed', 'b-ok'], draft: ['Draft — not yet checked by a person', 'b-draft'],
  stale: ['Review needed', 'b-warn'], none: ['Not documented yet', 'b-bad'],
};
const badge = ([label, cls], title = '') => html`<span class="badge ${cls}" title="${title}">${label}</span>`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- state ------------------------------------------------------------
let mode = store.get('mode', 'admin') === 'dev' ? 'dev' : 'admin';
let featureTab = null;   // null = follow the mode

// ---------- navigation -------------------------------------------------------
function navHtml(current) {
  const a = (href, label, count) => html`<a href="${href}" aria-current="${current === href ? 'page' : 'false'}"><span>${label}</span>${count !== undefined ? html`<span class="count">${count}</span>` : ''}</a>`;
  const guide = html`<h4>Guide</h4>${a('#home', 'Overview')}${a('#features', 'All features', FEATURES.length)}${mode === 'admin' ? a('#manual', 'Admin manual') : ''}${a('#troubleshoot', 'Troubleshooting', K.troubleshooting.length)}${mode === 'admin' ? a('#onboard', 'Onboarding') : ''}${a('#health', 'Health')}`;
  const areas = html`<h4>${mode === 'admin' ? 'Areas' : 'Features by area'}</h4>${GROUPS.map((g) => a(`#m-${g.key}`, g.label, g.items.length))}`;
  const code = mode === 'dev' ? html`<h4>Code &amp; data</h4>${a('#map', 'Module map')}${a('#db', 'Database tables', Object.keys(K.schema.tables).length)}${a('#functions', 'Database functions', Object.keys(K.schema.functions).length)}${a('#api', 'api.js wrappers', Object.keys(K.wrappers).length)}${a('#infra', 'Infrastructure')}${a('#live', 'Repo vs live')}${a('#timeline', 'Patch timeline', K.commits.length)}${a('#adrs', 'Decisions (ADRs)', K.adrs.length)}${a('#impact', 'Impact estimator')}${a('#onboard', 'Onboarding')}` : '';
  return html`${guide}${code}${areas}`;
}

// ---------- progress ring (SVG, no deps) -------------------------------------
function ring(value, max, colour = 'var(--accent)') {
  const pct2 = max ? Math.round((value / max) * 100) : 0;
  const r = 24, circ = 2 * Math.PI * r, dash = (pct2 / 100) * circ;
  return html`<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="6"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="${colour}" stroke-width="6"
      stroke-dasharray="${dash} ${circ}" stroke-dashoffset="${circ / 4}" stroke-linecap="round"/>
    <text x="32" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="var(--ink)">${pct2}%</text>
  </svg>`;
}

// ---------- views ------------------------------------------------------------
const views = {
  home() {
    const h = K.health;
    const rv = K.repoVsLive;
    const notApplied = rv.migrations.rows.filter((r) => r.live === 'not-applied');
    const byHand = rv.migrations.rows.filter((r) => r.live === 'applied-by-hand');
    const liveMig = rv.migrations.rows.filter((r) => r.live !== 'not-applied').length;
    const totalMig = rv.migrations.rows.length;
    const docPct = pct(h.answersFilled, h.answersTotal);
    const revPct = pct(h.reviewed, h.features);
    const tagline = mode === 'admin'
      ? 'What every screen does, who can use it, and what to do when something goes wrong — in plain words, from the live codebase.'
      : 'Every screen traced to its files, api.js wrappers, database functions and migrations. Built by reading the repository — no AI at runtime.';
    return html`
      <div class="page-header">
        <h1 class="page-title">${K.project.name} Knowledge Base</h1>
        <p class="lead">${tagline}</p>
      </div>

      <!-- Stat cards row -->
      <div class="stat-grid">
        <a class="stat-card" href="#features">
          <span class="stat-num">${h.features}</span>
          <span class="stat-label">Features &amp; screens</span>
        </a>
        <a class="stat-card ${h.stale.length ? 'warn-card' : 'ok-card'}" href="#health">
          <div class="ring-card">
            ${ring(h.answersFilled, h.answersTotal, docPct > 80 ? 'var(--ok)' : docPct > 50 ? 'var(--warn)' : 'var(--bad)')}
            <div class="ring-text">
              <span class="ring-pct">${docPct}%</span>
              <span class="stat-label">Docs complete</span>
              <span class="small muted">${h.reviewed} reviewed · ${h.draft} draft</span>
            </div>
          </div>
        </a>
        <a class="stat-card ${liveMig < totalMig ? 'warn-card' : 'ok-card'}" href="#live">
          <span class="stat-num">${liveMig}/${totalMig}</span>
          <span class="stat-label">Migrations in production</span>
        </a>
        <a class="stat-card ${h.untested.length ? 'warn-card' : 'ok-card'}" href="#health">
          <span class="stat-num">${h.untested.length}</span>
          <span class="stat-label">Screens without a test</span>
        </a>
      </div>

      <!-- Alerts -->
      ${h.stale.length ? html`<div class="callout warn"><strong>${plural(h.stale.length, 'guide')} need re-review</strong>The code changed since a person last checked: ${h.stale.map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`)}.${h.stale.length > 3 ? html` <a href="#health">See all →</a>` : ''}</div>` : ''}
      ${h.notReadyLive.length ? html`<div class="callout bad"><strong>Not fully live</strong>${h.notReadyLive.map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`)} — deployed code but undeployed database objects. <a href="#health">Details →</a></div>` : ''}
      ${notApplied.length || byHand.length || rv.migrations.liveOnly.length ? html`<div class="callout info"><strong>Migration drift detected</strong>
        ${notApplied.length ? html`Not applied: ${notApplied.map((r) => r.file).join(', ')}. ` : ''}
        ${byHand.length ? html`Applied by hand: ${byHand.map((r) => r.file).join(', ')}. ` : ''}
        ${rv.migrations.liveOnly.length ? html`Live-only (no file): ${rv.migrations.liveOnly.map((r) => `${r.version}_${r.name}`).join(', ')}. ` : ''}
        <a href="#live">Repo vs live →</a></div>` : ''}

      <!-- Documentation coverage by module -->
      <section class="section">
        <div class="section-header"><h2>Areas</h2><a href="#features">All features →</a></div>
        <div class="grid">
          ${GROUPS.map((g) => {
            const done = g.items.filter((f) => f.confidence !== 'none').length;
            return html`<a class="card" href="#m-${g.key}">
              <h3>${g.label}</h3>
              <span class="small muted">${g.area === 'admin' ? 'Admin · ' : ''}${plural(g.items.length, 'feature')}</span>
              <div class="bar"><span style="width:${pct(done, g.items.length)}%"></span></div>
              <span class="small muted">${done}/${g.items.length} documented</span>
            </a>`;
          })}
        </div>
      </section>

      <p class="small muted">Snapshot: ${rv.liveGenerated ?? 'none'} · Edge Functions: ${rv.edgeChecked ?? 'never'} · Supabase <code>${K.project.live?.id ?? '?'}</code> (${K.project.live?.region ?? '?'}).</p>`;
  },

  features(filterKey) {
    const groups = filterKey ? GROUPS.filter((g) => g.key === filterKey) : GROUPS;
    if (!groups.length) return notFound();
    return html`${filterKey ? html`<div class="crumbs"><a href="#features">All features</a> /</div>` : ''}
      <h1>${filterKey ? groups[0].label : 'All features'}</h1>
      ${groups.map((g) => html`<section class="section"><h2>${g.label}${g.area === 'admin' ? html` <span class="muted small">Admin app</span>` : ''}</h2>
        <div class="grid">${g.items.map(featureCard)}</div></section>`)}`;
  },

  feature(id) {
    const f = K.features[id];
    if (!f) return notFound();
    const tab = featureTab ?? mode;
    return html`
      <div class="crumbs"><a href="#features">Features</a> / <a href="#m-${groupKey(f)}">${f.area === 'admin' ? f.moduleLabel : f.areaLabel}</a> /</div>
      <div class="stack"><h1>${f.name}</h1>
        <div class="row">${badge(CONF[f.confidence])}${f.live.ready ? '' : badge(['Not fully live', 'b-bad'])}${f.tested || f.infrastructure ? '' : badge(['No automated test', 'b-warn'])}
          ${f.route ? html`<span class="chip">${f.role === 'admin' || f.role === 'restaurant' ? `${f.role}/` : ''}${f.route}</span>` : ''}</div></div>
      ${f.confidence === 'draft' ? html`<div class="callout draft"><strong>Draft</strong><span>${f.annotation?.drafted_by ? `Drafted by ${f.annotation.drafted_by}. ` : ''}A person has not yet checked these answers against the app. Answers marked "Verified" are read from the code and the live database and are reliable.</span></div>` : ''}
      ${f.confidence === 'stale' ? html`<div class="callout warn"><strong>Review needed</strong><span>Reviewed by ${f.annotation?.reviewed_by} on ${f.annotation?.reviewed_on}, but since then:</span><ul>${f.stale.map((s) => html`<li>${s.why}</li>`)}</ul></div>` : ''}
      ${f.live.ready ? '' : html`<div class="callout bad"><strong>Part of this is not live in production</strong><span>
        ${f.live.missingEdge.length ? html`Edge Function not deployed: ${f.live.missingEdge.join(', ')}. ` : ''}${f.live.missingFunctions.length ? html`Database function missing live: ${f.live.missingFunctions.join(', ')}. ` : ''}${f.live.missingTables.length ? html`Table missing live: ${f.live.missingTables.join(', ')}.` : ''}</span></div>`}
      <div class="tabs no-print" role="tablist"><button type="button" role="tab" data-tab="admin" aria-selected="${tab === 'admin'}">Admin guide</button><button type="button" role="tab" data-tab="dev" aria-selected="${tab === 'dev'}">Developer</button></div>
      ${tab === 'admin' ? adminGuide(f) : devView(f)}`;
  },

  manual() {
    return html`<h1>Admin manual</h1>
      <p class="lead">Every feature's guide on one page. To make a PDF, open the atlas file in a browser and use the browser's own Print → Save as PDF. The same text is in <code>appatlas/out/md/admin-manual.md</code>.</p>
      ${GROUPS.filter((g) => g.area !== 'infrastructure').map((g) => html`<section class="section"><h2>${g.label}</h2>
        ${g.items.map((f) => html`<div class="stack"><h3><a href="#f-${f.id}">${f.name}</a> ${badge(CONF[f.confidence])}</h3>${adminGuide(f, true)}</div>`)}</section>`)}`;
  },

  troubleshoot() {
    return html`<h1>Troubleshooting</h1>
      <p class="lead">Type what you see — an error message or a symptom. Matching is by the words in the catalog and the database's own messages; nothing is guessed.</p>
      <label class="field"><span class="small muted">Symptom or message</span><input id="tq" type="search" value="${store.get('tq', '')}" placeholder="e.g. Cannot approve a customer"></label>
      <div id="tr"></div>
      <section class="section"><h2>The whole catalog</h2><div class="table-wrap"><table><thead><tr><th>Symptom</th><th>Cause and fix</th><th>Features</th></tr></thead><tbody>
        ${K.troubleshooting.map((e) => html`<tr><td>${e.symptom}</td><td>${e.cause} ${e.fix}</td><td>${e.features.map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`)}</td></tr>`)}
      </tbody></table></div></section>`;
  },

  onboard(roleSlug) {
    const role = roleSlug ? ROLE[roleSlug] : null;
    const o = role ? K.onboarding[role] : null;
    return html`<h1>Onboarding</h1>
      <p class="lead">A checklist of the screens a new team member will use, from the live permission matrix${K.repoVsLive.liveGenerated ? ` (snapshot ${K.repoVsLive.liveGenerated})` : ''}.</p>
      <label class="field"><span class="small muted">Role</span><select id="role"><option value="">Choose a role…</option>
        ${Object.entries(K.onboarding).map(([code, r]) => html`<option value="${slug(code)}" ${code === role ? new Safe('selected') : ''}>${r.name}</option>`)}</select></label>
      ${o ? html`<div class="stack"><h2>${o.name}</h2><p class="muted">${o.description}</p>
        ${o.features.length ? html`<ol class="stack" id="checklist">${o.features.map((id) => { const f = K.features[id]; const what = f.answers.what_is_this.parts[0]?.value; const steps = f.answers.workflow.parts[0]?.value;
          return html`<li><a href="#f-${id}"><strong>${f.name}</strong></a> <span class="muted small">${f.moduleLabel}</span><br>${what ?? K.docRequired}${Array.isArray(steps) && steps.length ? html`<br><span class="small muted">First step: ${steps[0]}</span>` : ''}</li>`; })}</ol>
          <div class="row no-print"><button type="button" class="btn" id="copy-checklist">Copy as text</button><span id="copy-msg" class="small muted"></span></div>`
        : html`<p>This role opens no admin screens (it uses another app, or nothing is ticked for it under Settings → Roles).</p>`}</div>` : ''}`;
  },

  health() {
    const h = K.health;
    const list = (ids) => (ids.length ? html`<div class="chips">${ids.map((id) => html`<a class="chip" href="#f-${id}">${K.features[id]?.name ?? id}</a>`)}</div>` : html`<span class="muted">None.</span>`);
    return html`<h1>Health</h1><p class="lead">How complete and how trustworthy this atlas is, and what the code scan found.</p>
      <div class="grid">
        <div class="card"><span class="stat">${pct(h.answersFilled, h.answersTotal)}%</span><span class="stat-label">${h.answersFilled} of ${h.answersTotal} admin answers filled</span><div class="bar"><span style="width:${pct(h.answersFilled, h.answersTotal)}%"></span></div></div>
        <div class="card"><span class="stat">${h.reviewed}</span><span class="stat-label">features reviewed by a person</span><div class="bar"><span style="width:${pct(h.reviewed, h.features)}%"></span></div></div>
        <div class="card"><span class="stat">${h.draft}</span><span class="stat-label">drafts waiting for a person to check them</span></div>
        <div class="card"><span class="stat">${h.stale.length}</span><span class="stat-label">reviewed but stale (code changed)</span></div>
      </div>
      ${h.annotationErrors.length || h.troubleErrors.length ? html`<div class="callout bad"><strong>Annotation problems</strong><ul>${[...h.annotationErrors, ...h.troubleErrors].map((e) => html`<li><code>${e}</code></li>`)}</ul></div>` : ''}
      <section class="section"><h2>Needs attention</h2><dl class="facts">
        <dt>Review needed</dt><dd>${list(h.stale)}</dd>
        <dt>No annotation</dt><dd>${list(h.unannotated)}</dd>
        <dt>No automated test</dt><dd>${list(h.untested)}</dd>
        <dt>Not fully live</dt><dd>${list(h.notReadyLive)}</dd>
      </dl></section>
      ${mode === 'dev' ? html`<section class="section"><h2>Code scan</h2><dl class="facts">
        <dt>Import cycles</dt><dd>${h.importCycles.length ? h.importCycles.map((c) => html`<div><code>${c.join(' → ')}</code></div>`) : 'None.'}</dd>
        <dt>Files without a header comment</dt><dd>${h.filesWithoutHeader.length ? h.filesWithoutHeader.map((p) => html`<code>${p}</code> `) : 'None (every file has one).'}</dd>
        <dt>Screens over 250 lines</dt><dd>${h.largeScreens.length ? h.largeScreens.map((s) => html`<div><code>${s.file}</code> ${s.lines} lines</div>`) : 'None.'} <span class="small muted">code-rules: split a page by job past ~250 lines.</span></dd>
        <dt>Exports nobody imports</dt><dd>${h.unusedExports.filter((u) => !u.usedByTests).map((u) => html`<code>${u.file.split('/').pop()}:${u.name}</code> `)}
          <div class="small muted">${h.unusedExports.filter((u) => u.usedByTests).length} more are used only by tests (pure helpers).</div></dd>
        <dt>Git history</dt><dd>${h.gitAvailable ? `${K.commits.length} commits read` : 'Not available (not a git checkout).'}</dd>
      </dl></section>` : ''}`;
  },

  map() {
    const nodes = GROUPS.filter((g) => g.area !== 'infrastructure');
    const writes = (g) => new Set(g.items.flatMap((f) => f.tablesWritten.filter((t) => t !== 'audit_log')));
    const touches = (g) => new Set(g.items.flatMap((f) => [...f.tablesWritten, ...f.tablesRead].filter((t) => t !== 'audit_log')));
    const edges = [];
    nodes.forEach((a, i) => nodes.forEach((b, j) => {
      if (j <= i) return;
      const shared = [...writes(a)].filter((t) => touches(b).has(t)).concat([...writes(b)].filter((t) => touches(a).has(t)));
      const s = [...new Set(shared)].sort();
      if (s.length) edges.push({ a: a.key, b: b.key, tables: s });
    }));
    const W = 760, H = 560, cx = W / 2, cy = H / 2, R = 220;
    const pos = Object.fromEntries(nodes.map((g, i) => { const ang = (i / nodes.length) * Math.PI * 2 - Math.PI / 2; return [g.key, [cx + R * Math.cos(ang), cy + R * Math.sin(ang)]]; }));
    return html`<h1>Module map</h1>
      <p class="lead">Each circle is an area of the app. A line joins two areas when one changes a table the other reads or changes — the paths a change can travel. Click an area to see its connections.</p>
      <svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Module map">
        ${edges.map((e) => html`<line class="edge" data-a="${e.a}" data-b="${e.b}" x1="${pos[e.a][0]}" y1="${pos[e.a][1]}" x2="${pos[e.b][0]}" y2="${pos[e.b][1]}" stroke-width="${Math.min(1 + e.tables.length / 2, 7)}"></line>`)}
        ${nodes.map((g) => { const [x, y] = pos[g.key]; return html`<g class="node" data-node="${g.key}" tabindex="0"><circle cx="${x}" cy="${y}" r="${10 + Math.min(g.items.length * 2, 16)}"></circle><text x="${x}" y="${y + (y > cy ? 34 : -28)}" text-anchor="middle">${g.label}</text></g>`; })}
      </svg>
      <div id="map-detail" class="stack"><p class="muted">No area selected.</p></div>
      <script type="application/json" id="map-edges">${new Safe(JSON.stringify(edges).replace(/</g, '\\u003c'))}<\/script>`;   // <\/ so the page's own inline <script> does not end here
  },

  db() {
    const live = K.live?.database?.tables ?? {};
    return html`<h1>Database tables</h1><p class="lead">${Object.keys(K.schema.tables).length} tables and views from the migrations, with the live row estimate and Row Level Security switch.</p>
      <div class="table-wrap"><table><thead><tr><th>Table</th><th>What it holds</th><th>RLS live</th><th class="num">Rows (est.)</th><th class="num">Policies</th><th class="num">Features</th></tr></thead><tbody>
      ${Object.values(K.schema.tables).sort((a, b) => a.name.localeCompare(b.name)).map((t) => html`<tr><td><a href="#t-${slug(t.name)}"><code>${t.name}</code></a>${t.kind === 'view' ? html` <span class="badge b-plain">view</span>` : ''}</td>
        <td class="small">${t.comment || html`<span class="muted">—</span>`}</td><td>${t.kind === 'view' ? '—' : live[t.name] ? (live[t.name].rls ? badge(['on', 'b-ok']) : badge(['OFF', 'b-bad'])) : badge(['not live', 'b-warn'])}</td>
        <td class="num">${live[t.name]?.rows ?? '—'}</td><td class="num">${Object.keys(K.schema.policies[t.name] ?? {}).length}</td><td class="num">${(K.usedBy.table[t.name] ?? []).length}</td></tr>`)}
      </tbody></table></div>`;
  },

  table(s) {
    const name = TABLE[s];
    const t = K.schema.tables[name];
    if (!t) return notFound();
    const live = K.live?.database?.tables?.[name];
    const pols = Object.values(K.schema.policies[name] ?? {});
    const writers = Object.values(K.schema.functions).filter((f) => f.writes.includes(name) && !f.legacy).map((f) => f.name);
    const trig = K.schema.triggers.filter((x) => x.table === name);
    const users = K.usedBy.table[name] ?? [];
    return html`<div class="crumbs"><a href="#db">Database tables</a> /</div><h1><code>${name}</code></h1>
      ${t.comment ? html`<p class="lead">${t.comment}</p>` : ''}
      <dl class="facts"><dt>Created in</dt><dd><code>${t.createdIn}</code></dd><dt>Changed by</dt><dd>${t.migrations.map((m) => html`<code>${m}</code> `)}</dd>
        <dt>Live</dt><dd>${live ? html`RLS ${live.rls ? 'on' : html`<strong>off</strong>`} · about ${live.rows} rows` : t.kind === 'view' ? 'view' : html`<strong>not in the live snapshot</strong>`}</dd>
        <dt>Written by</dt><dd><div class="chips">${writers.map(fLink)}</div></dd>
        <dt>Triggers</dt><dd>${trig.length ? trig.map((x) => html`<div><code>${x.name}</code> → ${fLink(x.function)}</div>`) : 'None.'}</dd>
        <dt>Used by features</dt><dd>${users.length ? users.map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`) : 'None found.'}</dd></dl>
      <section class="section"><h2>Columns</h2><div class="table-wrap"><table><thead><tr><th>Column</th><th>Note</th></tr></thead><tbody>
        ${t.columns.map((c) => html`<tr><td><code>${c}</code></td><td class="small">${t.columnComments[c] ?? ''}</td></tr>`)}</tbody></table></div></section>
      <section class="section"><h2>Row Level Security policies</h2>${pols.length ? html`<div class="table-wrap"><table><thead><tr><th>Policy</th><th>For</th><th>Who</th><th>Rule</th></tr></thead><tbody>
        ${pols.map((p) => html`<tr><td><code>${p.name}</code></td><td>${p.cmd}</td><td>${p.to}</td><td class="small mono">${p.using || p.check || '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No policies in the migrations.</p>`}</section>`;
  },

  functions() {
    const live = K.live?.database?.functions ?? {};
    const list = Object.values(K.schema.functions).sort((a, b) => a.legacy - b.legacy || a.name.localeCompare(b.name));
    const called = new Set(Object.values(K.wrappers).flatMap((w) => w.rpcs));
    return html`<h1>Database functions</h1><p class="lead">Every write in the app goes through one of these (ADR 0002). ${list.filter((f) => f.securityDefiner).length} are SECURITY DEFINER; ${list.filter((f) => f.legacy).length} are kept as <code>_legacy</code> under the never-drop rule.</p>
      <div class="table-wrap"><table><thead><tr><th>Function</th><th>Checks</th><th>Writes</th><th>Defined in</th><th>Live</th><th>Called from web</th></tr></thead><tbody>
      ${list.map((f) => html`<tr><td><a href="#fn-${slug(f.name)}"><code>${f.name}</code></a>${f.legacy ? html` <span class="badge b-plain">legacy</span>` : ''}${f.trigger ? html` <span class="badge b-info">trigger</span>` : ''}</td>
        <td class="small">${f.permissions.join(', ')}${f.roles.length ? ` role: ${f.roles.join('/')}` : ''}</td><td class="small">${f.writes.join(', ')}</td><td class="small mono">${f.definedIn.slice(0, 14)}</td>
        <td>${live[f.name] ? badge(['live', 'b-ok']) : badge(['missing', 'b-bad'])}</td><td>${called.has(f.name) ? 'yes' : ''}</td></tr>`)}
      </tbody></table></div>`;
  },

  fn(s) {
    const name = FN[s];
    const f = K.schema.functions[name];
    if (!f) return notFound();
    const live = K.live?.database?.functions?.[name];
    const wrappers = Object.values(K.wrappers).filter((w) => w.rpcs.includes(name)).map((w) => w.name);
    const callers = Object.values(K.schema.functions).filter((x) => x.calls.includes(name)).map((x) => x.name);
    const checks = K.securityChecks.filter((c) => c.text.includes(name));
    const users = K.usedBy.function[name] ?? [];
    return html`<div class="crumbs"><a href="#functions">Database functions</a> /</div><h1><code>${name}(${f.args.join(', ')})</code></h1>
      ${f.comment ? html`<p class="lead">${f.comment}</p>` : ''}
      <dl class="facts"><dt>Returns</dt><dd><code>${f.returns || '?'}</code></dd>
        <dt>Security</dt><dd>${f.securityDefiner ? 'SECURITY DEFINER' : 'invoker'}${f.securityDefiner ? (f.searchPathSet ? ' · search_path pinned' : html` · <strong>search_path not set</strong>`) : ''}</dd>
        <dt>Defined in</dt><dd><code>${f.definedIn}</code>${f.migrations.length > 1 ? html` <span class="muted small">(${f.migrations.length} versions)</span>` : ''}${f.renamedIn ? html` · renamed in <code>${f.renamedIn}</code>` : ''}</dd>
        <dt>Live</dt><dd>${live ? `yes · ${live.overloads} overload(s)` : html`<strong>missing in the live snapshot</strong>`}</dd>
        <dt>Permission checks</dt><dd>${f.permissions.length ? f.permissions.map((p) => html`<code>has_permission('${p.split(':')[0]}', '${p.split(':')[1]}')</code> `) : 'None in the body.'}${f.roles.length ? html` · app_role: ${f.roles.join(', ')}` : ''}</dd>
        <dt>Reads</dt><dd><div class="chips">${f.reads.map(tLink)}</div></dd><dt>Writes</dt><dd><div class="chips">${f.writes.map(tLink)}</div></dd>
        <dt>Calls</dt><dd><div class="chips">${f.calls.map(fLink)}</div></dd><dt>Called by</dt><dd><div class="chips">${callers.map(fLink)}</div></dd>
        <dt>api.js wrappers</dt><dd>${wrappers.map((w) => html`<code>${w}()</code> `)}</dd>
        <dt>Features</dt><dd>${users.map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`)}</dd>
        <dt>Security checks naming it</dt><dd>${checks.length ? checks.map((c) => html`<div><code>${c.id}</code> ${c.text}</div>`) : 'None name it directly.'}</dd></dl>
      ${f.errors.length ? html`<section class="section"><h2>Messages it can refuse with</h2><ul>${f.errors.map((e) => html`<li>${e}</li>`)}</ul></section>` : ''}`;
  },

  api() {
    return html`<h1>api.js wrappers</h1><p class="lead">The browser's whole backend surface: pages never call Supabase directly (AGENTS.md rule 1).</p>
      <div class="table-wrap"><table><thead><tr><th>Wrapper</th><th>Line</th><th>Database functions</th><th>Tables</th><th>Other</th><th class="num">Features</th></tr></thead><tbody>
      ${Object.values(K.wrappers).sort((a, b) => a.line - b.line).map((w) => html`<tr><td><code>${w.name}()</code></td><td class="num">${w.line}</td>
        <td><div class="chips">${w.rpcs.map(fLink)}</div></td><td class="small">${Object.entries(w.tables).map(([t, ops]) => html`${tLink(t)} <span class="muted">${ops.join('/')}</span> `)}</td>
        <td class="small">${[...w.storage.map((b) => `storage:${b}`), ...w.edge.map((e) => `edge:${e}`), ...(w.auth ? ['auth'] : [])].join(' ')}</td><td class="num">${(K.usedBy.wrapper[w.name] ?? []).length}</td></tr>`)}
      </tbody></table></div>`;
  },

  infra() {
    const ids = ['infra-supabase-auth', 'infra-supabase-postgres', 'infra-supabase-storage', 'infra-supabase-edge-functions'];
    const i = K.infra;
    const counted = {
      'infra-supabase-auth': html`${i.auth.sqlFunctionsUsingAuthUid.length} database functions call <code>auth.uid()</code>; browser files: ${i.auth.files.map((p) => html`<code>${p}</code> `)}; Edge Functions using the admin API: ${i.auth.edgeFunctions.join(', ')}.`,
      'infra-supabase-postgres': html`${i.postgres.tables} tables/views · ${i.postgres.functions} functions (${i.postgres.definer} SECURITY DEFINER) · ${i.postgres.policies} policies · ${i.postgres.triggers} triggers · ${i.postgres.migrations} migrations.`,
      'infra-supabase-storage': html`Buckets: ${i.storage.buckets.map((b) => html`<code>${b.name}</code>${b.public ? ' (public)' : ' (private)'} `)} · wrappers: ${i.storage.wrappers.map((w) => html`<code>${w.name}()</code> `)}`,
      'infra-supabase-edge-functions': html`${i.edge.map((e) => html`<div><code>${e.name}</code> ${e.deployed ? badge(['deployed', 'b-ok']) : badge(['not deployed', 'b-bad'])} <span class="small muted">secrets: ${e.secrets.filter((x) => !x.startsWith('SUPABASE_')).join(', ') || 'none extra'}${e.hosts.length ? ` · talks to ${e.hosts.join(', ')}` : ''}</span></div>`)}`,
    };
    return html`<h1>Infrastructure &amp; migration guide</h1><p class="lead">The four Supabase services the app runs on, what each does, and what changes if you move off it. Counts are read from the code; effort and alternatives come from the infrastructure annotations.</p>
      ${ids.map((id) => { const f = K.features[id]; const g = f?.annotation?.migration_guide;
        return html`<section class="section"><h2>${f ? html`<a href="#f-${id}">${f.name}</a>` : id}</h2>
          ${f ? html`<p>${f.answers.what_is_this.parts[0]?.value ?? K.docRequired}</p>` : html`<p class="missing">${K.docRequired}</p>`}
          <div class="card"><strong class="small">Counted from the code</strong><div>${counted[id]}</div></div>
          ${g ? html`<dl class="facts"><dt>Effort to replace</dt><dd>${g.effort ?? '?'}</dd><dt>Alternatives</dt><dd>${(g.alternatives ?? []).join(', ')}</dd>
            ${g.what_changes_for_admin ? html`<dt>For admins</dt><dd>${g.what_changes_for_admin}</dd>` : ''}${g.what_stays_same ? html`<dt>Stays the same</dt><dd>${g.what_stays_same}</dd>` : ''}
            ${f.annotation.developer?.code_to_replace?.length ? html`<dt>Code to replace</dt><dd>${f.annotation.developer.code_to_replace.map((c) => html`<div><code>${c}</code></div>`)}</dd>` : ''}</dl>` : ''}</section>`; })}`;
  },

  live() {
    const rv = K.repoVsLive;
    const label = { applied: badge(['applied', 'b-ok']), 'applied-by-hand': badge(['applied by hand — not in the log', 'b-warn']), 'not-applied': badge(['not applied', 'b-bad']) };
    const issue = (title, items) => html`<dt>${title}</dt><dd>${items.length ? items.map((x) => html`<code>${x}</code> `) : html`<span class="muted">None.</span>`}</dd>`;
    return html`<h1>Repo vs live</h1>
      <p class="lead">What is in the repository compared with what the live Supabase project reports. Snapshot of the database: ${rv.liveGenerated ?? 'none'}; Edge Functions checked ${rv.edgeChecked ?? 'never'}. Refresh with <code>supabase/tests/appatlas_snapshot.sql</code> (see docs/appatlas.md).</p>
      <section class="section"><h2>Migrations</h2><div class="table-wrap"><table><thead><tr><th>File</th><th>Status</th><th>Live version</th><th>Creates</th></tr></thead><tbody>
        ${rv.migrations.rows.map((m) => html`<tr><td><code>${m.file}</code></td><td>${label[m.live]}</td><td class="mono small">${m.liveVersion ?? ''}</td><td class="small">${m.created.length} objects</td></tr>`)}
        ${rv.migrations.liveOnly.map((m) => html`<tr><td><code>${m.version}_${m.name}</code></td><td>${badge(['live only — no file in the repo', 'b-warn'])}</td><td class="mono small">${m.version}</td><td></td></tr>`)}
      </tbody></table></div></section>
      <section class="section"><h2>Edge Functions</h2><div class="table-wrap"><table><thead><tr><th>Function</th><th>Deployed</th><th>Called from the web app</th></tr></thead><tbody>
        ${rv.edge.map((e) => html`<tr><td><code>${e.name}</code></td><td>${e.deployed ? badge(['deployed', 'b-ok']) : badge(['not deployed', 'b-bad'])}</td><td>${e.calledFromWeb ? 'yes' : 'no (called by an outside service)'}</td></tr>`)}
        ${rv.edgeLiveOnly.map((e) => html`<tr><td><code>${e}</code></td><td>${badge(['live only', 'b-warn'])}</td><td></td></tr>`)}
      </tbody></table></div></section>
      <section class="section"><h2>Database checks</h2><dl class="facts">
        ${issue('Functions in the repo, missing live', rv.functionsNotLive)}${issue('Functions live, not in the repo', rv.functionsLiveOnly)}
        ${issue('Tables in the repo, missing live', rv.tablesNotLive)}${issue('Tables live, not in the repo', rv.tablesLiveOnly)}
        ${issue('Called by api.js but missing live', rv.rpcCalledButNotLive)}${issue('Live tables with RLS off', rv.tablesWithoutRls)}
        ${issue('SECURITY DEFINER without a pinned search_path', rv.definerWithoutSearchPath)}${issue('Storage buckets missing live', rv.bucketsNotLive)}
      </dl></section>`;
  },

  timeline() {
    return html`<h1>Patch timeline</h1><p class="lead">Every commit, newest first, with the features whose files or migrations it touched.</p>
      ${K.commits.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Commit</th><th>What</th><th>Features</th></tr></thead><tbody>
        ${K.commits.map((c) => html`<tr><td class="small mono">${c.date.slice(0, 10)}</td><td class="mono small">${c.short}</td><td>${c.subject}<div class="small muted">${c.author} · ${plural(c.files.length, 'file')}</div></td>
          <td class="small">${(COMMIT_FEATURES[c.short] ?? []).slice(0, 12).map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`)}${(COMMIT_FEATURES[c.short] ?? []).length > 12 ? ` and ${(COMMIT_FEATURES[c.short]).length - 12} more` : ''}</td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">No git history was available when the atlas was built.</p>`}
      ${K.patchDocs.length ? html`<section class="section"><h2>Patch notes</h2><ul>${K.patchDocs.map((d) => html`<li><code>${d.file}</code> — ${d.title}</li>`)}</ul></section>` : ''}`;
  },

  adrs() {
    return html`<h1>Decisions (ADRs)</h1><p class="lead">Why the app is built the way it is.</p>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Decision</th><th>Status</th><th class="num">Features</th></tr></thead><tbody>
      ${K.adrs.map((d) => html`<tr><td class="mono">${d.id}</td><td><a href="#adr-${d.id}">${d.title}</a></td><td class="small">${d.status}</td><td class="num">${FEATURES.filter((f) => f.adrs.includes(d.id)).length}</td></tr>`)}
      </tbody></table></div>`;
  },

  adr(id) {
    const d = K.adrs.find((x) => x.id === id);
    if (!d) return notFound();
    const fs = FEATURES.filter((f) => f.adrs.includes(id));
    return html`<div class="crumbs"><a href="#adrs">Decisions</a> /</div><h1>${d.id} — ${d.title}</h1><div class="row">${badge([d.status, 'b-plain'])}<code>${d.file}</code></div>
      ${d.context ? html`<section class="section"><h2>Context</h2><p>${d.context}</p></section>` : ''}
      ${d.decision ? html`<section class="section"><h2>Decision</h2><p>${d.decision}</p></section>` : ''}
      ${d.consequences ? html`<section class="section"><h2>Consequences</h2><pre class="block">${d.consequences}</pre></section>` : ''}
      <section class="section"><h2>Features it governs</h2>${fs.length ? html`<div class="chips">${fs.map((f) => html`<a class="chip" href="#f-${f.id}">${f.name}</a>`)}</div>` : html`<p class="muted">No feature names its functions or files.</p>`}</section>`;
  },

  impact() {
    const kinds = { table: 'Table', function: 'Database function', wrapper: 'api.js wrapper', file: 'File', edge: 'Edge Function', bucket: 'Storage bucket' };
    const kind = store.get('ik', 'table');
    const options = Object.keys(K.usedBy[kind] ?? {}).sort();
    const item = store.get('ii', '');
    const ids = K.usedBy[kind]?.[item] ?? [];
    return html`<h1>Impact estimator</h1><p class="lead">Pick something you plan to change and see every feature that depends on it — from the code, without running anything.</p>
      <div class="row"><label class="field"><span class="small muted">Kind</span><select id="ik">${Object.entries(kinds).map(([k, l]) => html`<option value="${k}" ${k === kind ? new Safe('selected') : ''}>${l}</option>`)}</select></label>
        <label class="field" style="flex:1;min-width:0"><span class="small muted">Item</span><select id="ii"><option value="">Choose…</option>${options.map((o) => html`<option value="${o}" ${o === item ? new Safe('selected') : ''}>${o}</option>`)}</select></label></div>
      ${item ? html`<section class="section"><h2>${plural(ids.length, 'feature')} depend on ${item}</h2>
        ${ids.length ? html`<div class="grid">${ids.map((id) => featureCard(K.features[id]))}</div>` : html`<p class="muted">Nothing found. It may be unused, or used only by the database itself.</p>`}
        ${kind === 'table' && K.schema.tables[item] ? html`<p><a href="#t-${slug(item)}">Open the table</a> for its writers, triggers and policies.</p>` : ''}
        ${kind === 'function' && K.schema.functions[item] ? html`<p><a href="#fn-${slug(item)}">Open the function</a> for its callers and checks.</p>` : ''}</section>` : ''}`;
  },
};

function notFound() { return html`<h1>Not found</h1><p>Nothing at this address. <a href="#home">Back to the overview</a>.</p>`; }

function featureCard(f) {
  const what = f.answers.what_is_this.parts[0]?.value;
  return html`<a class="card" href="#f-${f.id}"><h3>${f.name}</h3><span class="small muted">${typeof what === 'string' ? (what.length > 150 ? `${what.slice(0, 147)}…` : what) : K.docRequired}</span>
    <div class="row">${badge(CONF[f.confidence])}${f.live.ready ? '' : badge(['Not fully live', 'b-bad'])}${f.tested || f.infrastructure ? '' : badge(['No test', 'b-warn'])}</div></a>`;
}

function partHtml(p) {
  const [label, cls, title] = SRC[p.source] ?? [p.source, 'b-plain', ''];
  let body;
  if (Array.isArray(p.value) && p.value.length && typeof p.value[0] === 'object') {
    body = html`<ul>${p.value.map((e) => html`<li><span class="err-symptom">${e.symptom}</span> — ${e.solution}</li>`)}</ul>`;
  } else if (Array.isArray(p.value)) {
    body = html`<ol>${p.value.map((s) => html`<li>${s}</li>`)}</ol>`;
  } else {
    body = html`<p>${p.value}</p>`;
  }
  return html`<div class="part">${body}<div>${badge([label, cls], title)}</div></div>`;
}

function adminGuide(f, compact = false) {
  return html`${f.screenshot && !compact ? html`<img class="shot" src="${f.screenshot}" alt="Screenshot of ${f.name}">` : ''}
    <div class="qa">${K.questions.map((q, i) => { const a = f.answers[q.key];
      return html`<div class="q"><div class="q-head"><span class="q-num">${i + 1}</span><span class="q-title">${q.q}</span></div>
        ${a.missing ? html`<p class="missing">${K.docRequired}</p>` : a.parts.map(partHtml)}</div>`; })}</div>`;
}

function devView(f) {
  const files = f.files.map((p) => html`<div><code>${p}</code> <span class="muted small">${K.modules[p]?.lines ?? '?'} lines</span></div>`);
  const screens = f.screens.map((id) => K.screens.find((s) => s.id === id)).filter(Boolean);
  return html`<dl class="facts">
      <dt>Screens</dt><dd>${screens.length ? screens.map((s) => html`<div><code>${s.id}</code>${s.main ? html` — route in <code>${s.main}</code>${s.mainLine ? `:${s.mainLine}` : ''}` : ''}${s.module ? html` · guard module <code>${s.module}</code>` : ''}</div>`) : 'None (background job or infrastructure).'}</dd>
      <dt>Files</dt><dd>${files.length ? files : '—'}</dd>
      <dt>api.js wrappers</dt><dd><div class="chips">${f.wrappers.map((n) => html`<span class="chip">${n}() :${K.wrappers[n]?.line}</span>`)}</div></dd>
      <dt>Database functions reached</dt><dd><div class="chips">${f.reach.functions.map(fLink)}</div></dd>
      <dt>Writes</dt><dd><div class="chips">${f.tablesWritten.map(tLink)}</div></dd>
      <dt>Reads</dt><dd><div class="chips">${f.tablesRead.map(tLink)}</div></dd>
      <dt>Permission checks</dt><dd>${f.reach.permissions.length ? f.reach.permissions.map((p) => html`<code>${p}</code> `) : '—'}</dd>
      <dt>Storage / Edge</dt><dd>${[...f.buckets.map((b) => `bucket ${b}`), ...f.edgeFunctions.map((e) => `edge ${e}`)].join(' · ') || '—'}</dd>
      <dt>Migrations</dt><dd>${f.migrations.map((m) => html`<div><code>${m}</code></div>`)}</dd>
      <dt>Page tests</dt><dd>${f.pageTests.length ? f.pageTests.map((t) => html`<div class="small">✓ ${t}</div>`) : html`<span class="badge b-warn">none</span>`}</dd>
      <dt>Security checks</dt><dd>${f.securityChecks.length ? html`<details><summary>${plural(f.securityChecks.length, 'check')} in security_test.sql</summary>${f.securityChecks.map((c) => html`<div class="small"><code>${c.id}</code> ${c.text}</div>`)}</details>` : html`<span class="badge b-warn">none</span>`}</dd>
      <dt>Commits</dt><dd>${f.commits.length ? f.commits.map((c) => { const x = K.commits.find((y) => y.short === c); return html`<div class="small"><code>${c}</code> ${x?.subject ?? ''}</div>`; }) : '—'}</dd>
      <dt>Decisions</dt><dd>${f.adrs.map((id) => { const d = K.adrs.find((x) => x.id === id); return html`<div><a href="#adr-${id}">${id} — ${d?.title}</a></div>`; })}</dd>
      <dt>Docs</dt><dd>${f.docs.map((d) => html`<div><code>${d}</code></div>`)}</dd>
      <dt>Annotation</dt><dd>${f.annotation ? html`<code>${f.annotation.file}</code>` : html`none — <code>node tools/appatlas/cli.js annotate ${f.id}</code>`} · ${f.evidenceCount} pieces of evidence tracked for staleness</dd>
      ${f.annotation?.developer?.notes ? html`<dt>Notes</dt><dd>${f.annotation.developer.notes}</dd>` : ''}
      ${f.annotation?.developer?.known_issues?.length ? html`<dt>Known issues</dt><dd><ul>${f.annotation.developer.known_issues.map((x) => html`<li>${typeof x === 'string' ? x : `${x.issue ?? ''} ${x.status ? `(${x.status})` : ''}`}</li>`)}</ul></dd>` : ''}
    </dl>
    ${Object.keys(f.policies).length ? html`<section class="section"><h2>Policies on its tables</h2>${Object.entries(f.policies).map(([t, ps]) => html`<div class="small"><code>${t}</code>: ${ps.map((p) => `${p.name} (${p.cmd})`).join(', ')}</div>`)}</section>` : ''}`;
}

// ---------- search -----------------------------------------------------------
const norm = (s) => String(s ?? '').toLowerCase();
const INDEX = [
  ...FEATURES.map((f) => ({ kind: 'feature', label: f.name, sub: f.moduleLabel, href: `#f-${f.id}`,
    text: norm([f.name, f.id, f.screens, f.moduleLabel, ...Object.values(f.answers).flatMap((a) => a.parts.map((p) => JSON.stringify(p.value)))].join(' ')) })),
  ...Object.values(K.schema.tables).map((t) => ({ kind: 'table', label: t.name, sub: t.comment, href: `#t-${slug(t.name)}`, text: norm(`${t.name} ${t.comment} ${t.columns.join(' ')}`) })),
  ...Object.values(K.schema.functions).map((f) => ({ kind: 'function', label: `${f.name}()`, sub: f.errors[0] ?? '', href: `#fn-${slug(f.name)}`, text: norm(`${f.name} ${f.comment} ${f.errors.join(' ')}`) })),
  ...K.troubleshooting.map((e) => ({ kind: 'problem', label: e.symptom, sub: e.fix, href: e.features[0] ? `#f-${e.features[0]}` : '#troubleshoot', text: norm(`${e.symptom} ${e.cause} ${e.fix} ${e.match.join(' ')}`) })),
  ...K.adrs.map((d) => ({ kind: 'decision', label: `${d.id} ${d.title}`, sub: d.status, href: `#adr-${d.id}`, text: norm(`${d.id} ${d.title} ${d.decision}`) })),
];
const KIND_ORDER = { feature: 0, problem: 1, table: 2, function: 3, decision: 4 };
function search(q) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return INDEX.filter((e) => terms.every((t) => e.text.includes(t)))
    .map((e) => ({ e, s: norm(e.label).includes(norm(q)) ? 0 : 1 }))
    .sort((a, b) => a.s - b.s || KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind] || a.e.label.localeCompare(b.e.label))
    .slice(0, 15).map((x) => x.e);
}

// ---------- router & events --------------------------------------------------
function route() {
  const hash = location.hash.slice(1) || 'home';
  let body;
  let current = `#${hash}`;
  const m = /^(f|m|t|fn|adr|onboard)-(.+)$/.exec(hash);
  if (m) {
    const [, kind, arg] = m;
    body = kind === 'f' ? views.feature(arg) : kind === 'm' ? views.features(arg) : kind === 't' ? views.table(arg) : kind === 'fn' ? views.fn(arg) : kind === 'adr' ? views.adr(arg) : views.onboard(arg);
    current = { t: '#db', fn: '#functions', adr: '#adrs', onboard: '#onboard', f: '', m: `#m-${arg}` }[kind];
  } else {
    body = views[hash] && !['feature', 'table', 'fn', 'adr'].includes(hash) ? views[hash]() : notFound();
  }
  $('#nav').innerHTML = navHtml(current).v;
  $('#view').innerHTML = body.v;
  for (const b of document.querySelectorAll('.mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  if (hash === 'troubleshoot') runTroubleshoot();
}

function runTroubleshoot() {
  const input = $('#tq');
  const q = input.value.trim();
  store.set('tq', q);
  const box = $('#tr');
  if (!q) { box.innerHTML = ''; return; }
  const hits = matchTroubleshooting(K.troubleshooting, q);
  const n = norm(q);
  const dbHits = Object.values(K.schema.functions).flatMap((f) => f.errors.filter((e) => norm(e).includes(n) || n.includes(norm(e).replace(/…/g, '').trim().slice(0, 40))).map((e) => ({ e, f: f.name }))).slice(0, 20);
  box.innerHTML = html`<section class="section"><h2>${plural(hits.length, 'match', 'matches')} in the catalog</h2>
    ${hits.map((e) => html`<div class="card"><strong>${e.symptom}</strong><div><span class="muted">Cause:</span> ${e.cause}</div><div><span class="muted">Fix:</span> ${e.fix}</div>
      ${e.features.length ? html`<div class="small">${e.features.map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`)}</div>` : ''}</div>`)}
    ${dbHits.length ? html`<h2>The database says this in ${plural(dbHits.length, 'place')}</h2>${dbHits.map(({ e, f }) => html`<div class="card"><strong>${e}</strong><div class="small">From ${fLink(f)} — used by ${(K.usedBy.function[f] ?? []).slice(0, 6).map((id, i) => html`${i ? ', ' : ''}${featLink(id)}`)}</div></div>`)}` : ''}
    ${!hits.length && !dbHits.length ? html`<p class="muted">No entry matches. If this keeps happening, add it to <code>appatlas/troubleshooting.yaml</code> once the cause is known.</p>` : ''}</section>`.v;
}

document.addEventListener('click', (e) => {
  const modeBtn = e.target.closest('.mode button');
  if (modeBtn) { mode = modeBtn.dataset.mode; store.set('mode', mode); featureTab = null; route(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) { featureTab = tab.dataset.tab; route(); return; }
  const node = e.target.closest('[data-node]');
  if (node) showMapNode(node.dataset.node);
  if (e.target.closest('#copy-checklist')) copyChecklist();
  if (!e.target.closest('.search')) $('#results').hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest?.('[data-node]')) showMapNode(e.target.closest('[data-node]').dataset.node); });
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    const r = search(e.target.value);
    const box = $('#results');
    box.innerHTML = html`${r.map((x) => html`<a href="${x.href}"><span class="kind">${x.kind}</span>${x.label}${x.sub ? html`<div class="small muted">${String(x.sub).slice(0, 110)}</div>` : ''}</a>`)}${e.target.value && !r.length ? html`<a href="#troubleshoot"><span class="kind">none</span>No match — try Troubleshooting</a>` : ''}`.v;
    box.hidden = !e.target.value;
  }
  if (e.target.id === 'tq') runTroubleshoot();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'role') location.hash = e.target.value ? `onboard-${e.target.value}` : 'onboard';
  if (e.target.id === 'ik') { store.set('ik', e.target.value); store.set('ii', ''); route(); }
  if (e.target.id === 'ii') { store.set('ii', e.target.value); route(); }
});
document.addEventListener('focusin', (e) => { if (e.target.id === 'q' && e.target.value) $('#results').hidden = false; });

function showMapNode(key) {
  const edges = JSON.parse($('#map-edges').textContent);
  const mine = edges.filter((x) => x.a === key || x.b === key);
  const linked = new Set(mine.flatMap((x) => [x.a, x.b]));
  for (const n of document.querySelectorAll('.map .node')) n.classList.toggle('dim', !linked.has(n.dataset.node) && n.dataset.node !== key);
  for (const l of document.querySelectorAll('.map .edge')) l.classList.toggle('hot', l.dataset.a === key || l.dataset.b === key);
  const g = GROUPS.find((x) => x.key === key);
  $('#map-detail').innerHTML = html`<h2><a href="#m-${key}">${g.label}</a></h2>
    ${mine.length ? html`<div class="table-wrap"><table><thead><tr><th>Connected to</th><th>Through tables</th></tr></thead><tbody>${mine.map((x) => { const other = x.a === key ? x.b : x.a;
      return html`<tr><td><a href="#m-${other}">${GROUPS.find((y) => y.key === other).label}</a></td><td><div class="chips">${x.tables.map(tLink)}</div></td></tr>`; })}</tbody></table></div>` : html`<p class="muted">Shares no tables with other areas.</p>`}`.v;
}

async function copyChecklist() {
  const text = [...document.querySelectorAll('#checklist li')].map((li, i) => `${i + 1}. ${li.innerText.replace(/\s+/g, ' ').trim()}`).join('\n');
  try { await navigator.clipboard.writeText(text); $('#copy-msg').textContent = 'Copied.'; }
  catch {
    const range = document.createRange(); range.selectNodeContents($('#checklist'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    $('#copy-msg').textContent = 'Selected — press Ctrl+C (⌘C) to copy.';
  }
}

window.addEventListener('hashchange', () => { featureTab = null; route(); window.scrollTo(0, 0); $('#results').hidden = true; });
route();
