// =============================================================================
// atlas.js — AppAtlas knowledge-base viewer for the admin app.
//
// Loads the pre-built knowledge-graph.json from /appatlas/out/ and renders
// the full AppAtlas single-page knowledge base inside an iframe. No AI, no
// Supabase calls at runtime — the atlas is a static artefact built by
// `npm run atlas` and served as a plain file.
//
// Who can see this: only team members whose role has
//   role_permissions (team_role, 'knowledge_base', 'view') = true.
// A super admin grants that in Settings → Roles.
//
// Why an iframe: the AppAtlas page is a self-contained HTML document with its
// own CSS, JS and navigation. Embedding it in an iframe isolates its styles
// and its own router from the admin-app shell (ADR 0026).
// =============================================================================

import { html, mount } from '../../core/ui.js';
import { getAtlasData } from '../../core/api.js';

/**
 * Render the AppAtlas viewer.
 *
 * @param {HTMLElement} container
 * @param {{ team_role: string, full_name: string }} me
 */
export async function renderAtlas(container, me) {
  // Show a loading state while we confirm the atlas artefact exists.
  mount(container, html`
    <div class="page-header">
      <h1>Knowledge Base</h1>
      <p class="lead">The live codebase — every screen, function and database table, explained.</p>
    </div>
    <div class="empty" id="atlas-loading">Loading knowledge base…</div>
  `);

  let meta;
  try {
    meta = await getAtlasData();
  } catch (err) {
    mount(container, html`
      <div class="page-header">
        <h1>Knowledge Base</h1>
        <p class="lead">The live codebase — every screen, function and database table, explained.</p>
      </div>
      <div class="card">
        <strong>Atlas not built yet</strong>
        <p class="small muted">Run <code>npm run atlas</code> from the project root to generate it, then refresh this page.</p>
        <p class="small muted">${err.message}</p>
      </div>
    `);
    return;
  }

  // Atlas artefact exists — render the iframe viewer.
  const builtAt = meta?.meta?.generated ? new Date(meta.meta.generated).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
  const featureCount = meta?.health?.features ?? '?';
  const docPct = meta?.health?.answersFilled && meta?.health?.answersTotal
    ? Math.round((meta.health.answersFilled / meta.health.answersTotal) * 100)
    : '?';

  mount(container, html`
    <div class="page-header">
      <h1>Knowledge Base</h1>
      <p class="lead">The live codebase — every screen, function and database table, explained.</p>
    </div>
    <div class="stat-grid" style="margin-bottom:var(--sp-4)">
      <div class="stat-card">
        <span class="stat-num">${featureCount}</span>
        <span class="stat-label">Features documented</span>
      </div>
      <div class="stat-card">
        <span class="stat-num">${docPct}%</span>
        <span class="stat-label">Admin answers filled</span>
      </div>
      <div class="stat-card">
        <span class="stat-num">${meta?.meta?.migrationsTotal ?? '?'}</span>
        <span class="stat-label">Migrations</span>
      </div>
      <div class="stat-card" style="font-size:var(--text-sm);padding:var(--sp-3)">
        <span class="muted">Built</span><br>
        <strong>${builtAt}</strong><br>
        <span class="muted small">IST</span>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;border-radius:var(--r-lg)">
      <iframe
        id="atlas-frame"
        src="/appatlas/out/index.html"
        title="AppAtlas Knowledge Base"
        style="width:100%;height:calc(100vh - 260px);min-height:600px;border:none;display:block;"
        sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"
      ></iframe>
    </div>
    <p class="small muted" style="margin-top:var(--sp-2)">
      Rebuilt by running <code>npm run atlas</code> from the project root · Grants managed in
      <a href="#roles">Settings → Roles</a>
    </p>
  `);
}
