// Static checks: every file referenced by the HTML pages and every relative
// ES-module import actually exists. Catches typos that only show up in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
// path.sep: on Windows the folder is web\vendor, not web/vendor.
const files = walk(WEB).filter((f) => !f.includes(`${sep}vendor${sep}`));

test('HTML pages reference existing scripts and stylesheets', () => {
  for (const page of files.filter((f) => f.endsWith('.html'))) {
    const source = readFileSync(page, 'utf8');
    for (const [, ref] of source.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (/^(https?:|mailto:|tel:)/.test(ref)) continue;
      assert.ok(existsSync(resolve(dirname(page), ref.split('?')[0])), `${page} references missing ${ref}`);   // page.html?slug=… (019)
    }
  }
});

// The page tests build their own DOM, so they never load these HTML files. A shell missing
// the vendored client or the #app-header / #view mount points shows a blank page in the
// browser while every other test passes (this happened on 2026-10-28).
test('app shells load the Supabase client and have the header and view mount points', () => {
  for (const role of ['admin', 'restaurant', 'delivery']) {
    const source = readFileSync(join(WEB, role, 'index.html'), 'utf8');
    const vendor = source.indexOf('vendor/supabase.js');
    const module = source.indexOf(`js/pages/${role}/main.js`);
    assert.ok(vendor !== -1 && vendor < module, `${role}/index.html must load ../vendor/supabase.js before main.js`);
    assert.match(source, /id="app-header"/, `${role}/index.html needs <header id="app-header">`);
    assert.match(source, /id="view"/, `${role}/index.html needs <main id="view">`);
    assert.match(source, /css\/components\.css/, `${role}/index.html must load components.css`);
    assert.ok(!/<script>(?!\s*<\/script>)/.test(source), `${role}/index.html has an inline script the CSP blocks`);
  }
  for (const page of ['supplier/index.html', 'supplier/login.html']) {
    assert.match(readFileSync(join(WEB, page), 'utf8'), /vendor\/supabase\.js/, `${page} must load ../vendor/supabase.js`);
  }
});

test('relative JS imports resolve to real files', () => {
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(file, 'utf8');
    for (const [, ref] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      assert.ok(existsSync(resolve(dirname(file), ref)), `${file} imports missing ${ref}`);
    }
  }
});

test('no secret keys are shipped to the browser', () => {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!/service_role|sb_secret_/.test(source), `${file} mentions a secret key`);
  }
});
