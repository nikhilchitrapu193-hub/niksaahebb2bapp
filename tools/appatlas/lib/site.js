// =============================================================================
// site.js — writes the AppAtlas website: ONE self-contained HTML file with the
// knowledge base embedded as JSON, the styles and the script inlined. It opens
// straight from disk (no server, no network, no CDN), so it can be emailed,
// committed or hosted anywhere static.
//
// The troubleshooting matcher is copied into the page from annotations.js with
// Function.toString(), so the website and the CLI match symptoms with the same
// code instead of two copies that could drift (code-rules rule 8).
// fragment: true leaves out <!doctype>/<html>/<head>/<body> for hosts that wrap
// the page themselves (a published Claude artifact).
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTroubleshooting } from './annotations.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** The parts of the knowledge base the page needs (the JSON export keeps everything). */
function pageData(k, root) {
  const features = {};
  for (const [id, f] of Object.entries(k.features)) {
    const { evidence, annotation, ...rest } = f;
    const shot = annotation?.screenshot;
    let screenshot = null;
    if (shot && existsSync(join(root, shot)) && MIME[extname(shot).toLowerCase()]) {
      screenshot = `data:${MIME[extname(shot).toLowerCase()]};base64,${readFileSync(join(root, shot)).toString('base64')}`;
    }
    features[id] = { ...rest, evidenceCount: Object.keys(evidence).length, screenshot,
      annotation: annotation ? { file: annotation.file, drafted_by: annotation.drafted_by, reviewed_by: annotation.reviewed_by,
        reviewed_on: annotation.reviewed_on, developer: annotation.developer ?? {}, migration_guide: annotation.admin?.migration_guide ?? null } : null };
  }
  return { ...k, features, securityChecks: k.securityChecks.map(({ id, text }) => ({ id, text })) };
}

export function renderSite(k, { root, fragment = false }) {
  const css = readFileSync(join(here, '../site/app.css'), 'utf8');
  const js = readFileSync(join(here, '../site/app.js'), 'utf8');
  // </script> inside the JSON would end the script tag early; the \u003c escape keeps it inert.
  const data = JSON.stringify(pageData(k, root)).replace(/</g, '\\u003c');
  const title = `<title>${k.project.name} Atlas</title>`;
  const head = fragment
    ? `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n<meta name="description" content="AppAtlas knowledge base">`
    : `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${title}`;
  return `${head}
<style>
${css}
</style>
${fragment ? '' : '</head>\n<body>'}
<div id="atlas" class="atlas">
  <header class="topbar">
    <a class="brand" href="#home"><span class="brand-mark" aria-hidden="true">◈</span><span>${k.project.name} <b>Atlas</b></span></a>
    <div class="search"><input id="q" type="search" placeholder="Search features, tables, errors…" autocomplete="off" aria-label="Search the atlas"><div id="results" class="results" hidden></div></div>
    <div class="mode" role="group" aria-label="Mode">
      <button type="button" data-mode="admin">Admin</button><button type="button" data-mode="dev">Developer</button>
    </div>
  </header>
  <div class="layout">
    <nav id="nav" class="nav" aria-label="Sections"></nav>
    <main id="view" class="view" tabindex="-1"></main>
  </div>
</div>
<script id="atlas-data" type="application/json">${data}</script>
<script>
"use strict";
const matchTroubleshooting = ${matchTroubleshooting.toString()};
${js}
</script>
${fragment ? '' : '</body>\n</html>'}
`;
}
