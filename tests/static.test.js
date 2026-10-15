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
      assert.ok(existsSync(resolve(dirname(page), ref)), `${page} references missing ${ref}`);
    }
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
