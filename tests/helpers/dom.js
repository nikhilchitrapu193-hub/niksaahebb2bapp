// =============================================================================
// dom.js — builds a jsdom page and exposes it as the globals the app expects
// (document, window, location, localStorage). Lets us import the real page
// modules in Node and inspect the DOM they render.
// =============================================================================

import { JSDOM } from 'jsdom';

/** Create a page whose <body> is `bodyHtml`, and install browser globals. */
export function installDom(bodyHtml = '<header id="app-header"></header><main id="view"></main><div id="auth-root" data-role="restaurant"></div>') {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, { url: 'http://localhost/' });
  const { window } = dom;

  // jsdom's location can't navigate; use a simple recording stub instead.
  const location = { hash: '', href: '', search: '', replaced: null, replace(url) { this.replaced = url; } };

  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage,
    FormData: window.FormData, location,
  });
  return { dom, window, document: window.document, location };
}

/** Poll until `check()` is truthy (rendering is async), or fail after timeoutMs. */
export async function waitFor(check, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let importCounter = 0;
/** Import a page module (path relative to the project root) fresh so its top-level code runs again for each test. */
export function importFresh(relativePath) {
  importCounter += 1;
  return import(`${new URL('../../' + relativePath, import.meta.url).href}?run=${importCounter}`);
}
