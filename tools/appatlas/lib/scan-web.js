// =============================================================================
// scan-web.js — reads web/ and finds the screens, the import graph and what each
// screen asks the backend for.
//
//   screens   one per route in web/js/pages/<role>/main.js, one for the delivery
//             app, one per standalone page (web/*.html, the login pages)
//   wrappers  every export of web/js/core/api.js with the rpc / table / bucket /
//             Edge Function it uses — pages never call Supabase directly
//             (AGENTS.md rule 1), so this list is the complete backend surface
//   imports   file → file with the imported names, for the dependency graph,
//             circular-import detection and unused-export detection
// =============================================================================

import { dirname, join, resolve } from 'node:path';
import { readText, walk, rel, sha, stripJsComments, balanced, lineAt, headerComment, headerSummary, uniq } from './text.js';

/** import { a, b as c } from './x.js'  → [{ spec, names }] */
export function parseImports(src) {
  const out = [];
  const code = stripJsComments(src);
  for (const m of code.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = (m[2] ?? '').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    if (m[1]) names.push('default');
    if (m[3]) names.push('*');
    out.push({ spec: m[4], names });
  }
  for (const m of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], names: ['*'] });
  return out;
}

export function parseExports(src) {
  const code = stripJsComments(src);
  return uniq([
    ...[...code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/export\s+(?:const|let|var|class)\s+([\w$]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()).filter(Boolean)),
  ]);
}

/** Source text of one export: a function body, or a const up to the next top-level statement. */
export function exportBody(code, name) {
  const fn = new RegExp(`export\\s+(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(`).exec(code);
  if (fn) {
    const [, closeParen] = balanced(code, fn.index + fn[0].length, '(', ')');
    const open = code.indexOf('{', closeParen);
    return balanced(code, open + 1)[0];
  }
  const c = new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\b`).exec(code);
  if (!c) return '';
  const rest = code.slice(c.index + c[0].length);
  const end = rest.search(/\n(?=export\s|function\s|const\s|let\s|async\s)/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Each exported function in api.js with what it touches in the backend. */
export function scanWrappers(src, buckets = {}) {
  const code = stripJsComments(src);
  const out = {};
  const exportNames = parseExports(src);
  for (const m of code.matchAll(/export\s+(async\s+)?function\s+([\w$]+)\s*\(/g)) {
    const open = code.indexOf('{', m.index + m[0].length - 1 + balanced(code, m.index + m[0].length, '(', ')')[0].length);
    const [body] = balanced(code, open + 1);
    const tables = {};
    for (const t of body.matchAll(/\.from\(\s*['"]([a-z_0-9]+)['"]\s*\)((?:\s*\.\s*\w+\s*\([^;]*?\))*)/g)) {
      const ops = [...t[2].matchAll(/\.\s*(select|insert|update|upsert|delete)\s*\(/g)].map((x) => x[1]);
      tables[t[1]] = uniq([...(tables[t[1]] ?? []), ...(ops.length ? ops : ['select'])]);
    }
    const storage = uniq([...body.matchAll(/storage\s*\.from\(\s*(?:config\.(\w+)|['"]([\w-]+)['"])\s*\)/g)]
      .map((b) => (b[2] ?? buckets[b[1]] ?? b[1])));
    out[m[2]] = {
      name: m[2],
      line: lineAt(code, m.index),
      rpcs: uniq([...body.matchAll(/\.rpc\(\s*['"]([a-z_0-9]+)['"]/g)].map((r) => r[1])),
      tables,
      storage,
      edge: uniq([...body.matchAll(/functions\.invoke\(\s*['"]([\w-]+)['"]/g)].map((r) => r[1])),
      auth: /supabase\.auth\./.test(body),
      calls: uniq(exportNames.filter((n) => n !== m[2] && new RegExp(`\\b${n}\\s*\\(`).test(body))),
      hash: sha(body),
    };
  }
  return out;
}

/** api.js friendlyMessage(): Postgres error code → the sentence the person sees. */
export function scanFriendlyErrors(src) {
  const body = (/function friendlyMessage\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(src) || [, ''])[1];
  return [...body.matchAll(/code\s*===\s*'(\w+)'\)\s*return\s*'([^']+)'/g)].map((m) => ({ code: m[1], text: m[2] }));
}

/** Bucket names from web/js/core/config.js: { photoBucket: 'product-photos', … } */
export function scanConfigBuckets(src) {
  return Object.fromEntries([...src.matchAll(/(\w+Bucket)\s*:\s*['"]([\w-]+)['"]/g)].map((m) => [m[1], m[2]]));
}

/** Routes in a role's main.js: '#orders': guard('orders', (c) => renderOrders(…)) */
export function scanRoutes(src) {
  const code = stripJsComments(src);
  const routes = [];
  for (const m of code.matchAll(/['"](#[\w/-]+)['"]\s*:\s*(?:guard\(\s*['"](\w+)['"]\s*,\s*)?(?:\w+\()?\s*\([^)]*\)\s*=>\s*(render\w+)\s*\(/g)) {
    routes.push({ route: m[1], module: m[2] ?? null, render: m[3], line: lineAt(code, m.index) });
  }
  const fallback = (/fallback\s*:\s*[^'"]*['"](#[\w-]+)['"]/.exec(code) || [])[1] ?? null;
  return { routes, fallback };
}

export function scanWeb(root, cfg) {
  const webJs = join(root, 'web/js');
  const files = walk(webJs).filter((f) => f.endsWith('.js'));
  const src = Object.fromEntries(files.map((f) => [rel(root, f), readText(f)]));
  const apiPath = 'web/js/core/api.js';
  const buckets = scanConfigBuckets(src['web/js/core/config.js'] ?? '');
  const wrappers = scanWrappers(src[apiPath] ?? '', buckets);

  // Import graph between web/js files.
  const modules = {};
  for (const [path, text] of Object.entries(src)) {
    const imports = parseImports(text)
      .filter((i) => i.spec.startsWith('.'))
      .map((i) => ({ file: rel(root, resolve(root, dirname(path), i.spec)), names: i.names }));
    const header = headerComment(text);
    modules[path] = { path, imports, exports: parseExports(text), header, summary: headerSummary(header),
      lines: text.split('\n').length, hash: sha(text), hasHeader: header.length > 0 };
  }

  // Screens.
  const screens = [];
  const renderFile = {};   // renderOrders → web/js/pages/admin/orders.js
  for (const role of ['admin', 'restaurant']) {
    const mainPath = `web/js/pages/${role}/main.js`;
    if (!src[mainPath]) continue;
    for (const imp of modules[mainPath].imports) for (const n of imp.names) if (/^render/.test(n)) renderFile[`${role}:${n}`] = imp.file;
    const { routes, fallback } = scanRoutes(src[mainPath]);
    for (const r of routes) {
      const file = renderFile[`${role}:${r.render}`];
      screens.push({ id: `${role}${r.route.replace(/\/$/, '')}`, role, route: r.route, module: r.module,
        render: r.render, file, main: mainPath, mainLine: r.line, isDefault: r.route === fallback });
    }
  }
  if (src['web/js/pages/delivery/main.js']) {
    screens.push({ id: 'delivery#app', role: 'delivery', route: '#', module: null, render: null, file: 'web/js/pages/delivery/main.js', main: 'web/js/pages/delivery/main.js', isDefault: true });
  }
  // The restaurant cart drawer and checkout live in main.js + cart.js, not in a route.
  if (src['web/js/pages/restaurant/main.js']) {
    screens.push({ id: 'restaurant#cart', role: 'restaurant', route: '(cart drawer)', module: null, render: 'openCart',
      file: 'web/js/pages/restaurant/main.js', main: 'web/js/pages/restaurant/main.js', shellOnly: true });
  }
  // Standalone pages: web/*.html and web/<role>/login.html load one module each.
  const pages = walk(join(root, 'web')).filter((f) => f.endsWith('.html')).map((f) => rel(root, f));
  const seen = new Set();
  for (const page of pages) {
    const html = readText(join(root, page));
    const m = /src="([^"]*js\/pages\/([\w-]+)\.js)"/.exec(html);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    const role = m[2] === 'login' ? 'all' : ['po'].includes(m[2]) ? 'admin' : ['invoice', 'statement'].includes(m[2]) ? 'admin,restaurant' : 'public';
    screens.push({ id: `page#${m[2]}`, role, route: page, module: m[2] === 'po' ? 'procurement' : null, render: null,
      file: `web/js/pages/${m[2]}.js`, html: page, main: null });
  }

  // Files a screen depends on: follow imports, but not into another route's render function
  // (main.js imports every screen). When a screen borrows a helper from another screen's file
  // (help-centre.js takes settingsTabs from settings.js; orders.js takes receiptDialog from
  // payments.js), only the api.js calls inside the borrowed exports count, not the whole file.
  const routeTargets = new Set(screens.map((s) => s.file));
  const shared = new Set(cfg.shared_files ?? []);
  const apiNamesIn = (file, names) => {
    const apiImports = (modules[file]?.imports ?? []).filter((i) => i.file === apiPath).flatMap((i) => i.names);
    if (!names) return apiImports;
    const text = stripJsComments(src[file] ?? '');
    const bodies = names.map((n) => exportBody(text, n)).join('\n');
    return apiImports.filter((a) => new RegExp(`\\b${a}\\b`).test(bodies));
  };
  function closure(start, shellOnly) {
    const reached = new Map([[start, null]]);   // file → null (whole file) or [names borrowed]
    const stack = [start];
    while (stack.length) {
      const f = stack.pop();
      for (const imp of modules[f]?.imports ?? []) {
        if (imp.file === apiPath || !modules[imp.file]) continue;
        const isOtherScreen = routeTargets.has(imp.file) && imp.file !== start;
        if (isOtherScreen && imp.names.every((n) => /^render/.test(n))) continue;
        if (shellOnly && /\/pages\//.test(imp.file) && !/cart\.js$|ordering-plus\.js$/.test(imp.file)) continue;
        if (isOtherScreen) {
          const prev = reached.get(imp.file);
          if (prev === null) continue;
          reached.set(imp.file, [...new Set([...(prev ?? []), ...imp.names])]);
          continue;   // borrowed helpers: do not walk that screen's own imports
        }
        if (reached.has(imp.file)) continue;
        reached.set(imp.file, null); stack.push(imp.file);
      }
    }
    return reached;
  }
  for (const s of screens) {
    const reached = closure(s.file, s.shellOnly);
    const files = [...reached.keys()].sort();
    s.files = files;
    s.ownFiles = files.filter((f) => !shared.has(f));
    s.apiCalls = uniq([...reached].flatMap(([f, names]) => apiNamesIn(f, names))).filter((n) => wrappers[n]);
    // A wrapper that calls another wrapper reaches its backend too.
    s.apiCalls = uniq([...s.apiCalls, ...s.apiCalls.flatMap((n) => wrappers[n].calls)]);
    s.summary = modules[s.file]?.summary ?? '';
    s.header = modules[s.file]?.header ?? '';
  }

  return { modules, wrappers, screens, buckets, apiPath, friendlyErrors: scanFriendlyErrors(src[apiPath] ?? '') };
}

/** Tarjan's strongly connected components: every import cycle with more than one file. */
export function importCycles(modules) {
  let index = 0;
  const idx = {}, low = {}, onStack = new Set(), stack = [], cycles = [];
  function visit(v) {
    idx[v] = low[v] = index++; stack.push(v); onStack.add(v);
    for (const { file: w } of modules[v]?.imports ?? []) {
      if (!modules[w]) continue;
      if (idx[w] === undefined) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack.has(w)) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) cycles.push(comp.sort());
    }
  }
  for (const v of Object.keys(modules).sort()) if (idx[v] === undefined) visit(v);
  return cycles;
}

/** Exports nobody in web/js imports; `testSources` marks the ones only tests use. */
export function unusedExports(modules, testSources = '') {
  const used = new Set();
  for (const m of Object.values(modules)) for (const i of m.imports) for (const n of i.names) used.add(`${i.file}:${n}`);
  const out = [];
  for (const m of Object.values(modules)) {
    if (m.imports.some((i) => i.names.includes('*'))) continue;
    for (const e of m.exports) {
      if (used.has(`${m.path}:${e}`) || Object.values(modules).some((x) => x.imports.some((i) => i.file === m.path && i.names.includes('*')))) continue;
      out.push({ file: m.path, name: e, usedByTests: new RegExp(`\\b${e}\\b`).test(testSources) });
    }
  }
  return out;
}
