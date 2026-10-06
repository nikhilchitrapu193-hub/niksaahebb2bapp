// =============================================================================
// Dev server — serves the ./web folder over http://localhost:3000
//
// Why do we need this at all? The app uses ES modules (<script type="module">),
// and browsers refuse to load modules from file:// URLs. Any static server
// works; this one has ZERO dependencies (Node built-ins only) so there is
// nothing to install.
//
//   Run:  npm start          (or: node scripts/dev-server.js)
//   Port: PORT=8080 npm start
//
// This is for local development only. For production, upload the ./web folder
// to any static host (see docs/deployment.md).
// =============================================================================

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(new URL('../web', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Turn a request URL into a file path, refusing anything outside WEB_ROOT. */
function resolveFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = resolve(join(WEB_ROOT, normalize(decoded)));
  const insideRoot = candidate === WEB_ROOT || candidate.startsWith(WEB_ROOT + sep);
  return insideRoot ? candidate : null;
}

async function findFile(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  return info.isDirectory() ? join(path, 'index.html') : path;
}

const server = createServer(async (req, res) => {
  try {
    const target = resolveFilePath(req.url ?? '/');
    if (!target) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const file = await findFile(target);
    const body = file ? await readFile(file).catch(() => null) : null;
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // always show your latest edits
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`\n  Fresh Supply dev server running\n`);
  console.log(`  Open:  http://localhost:${PORT}\n`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
