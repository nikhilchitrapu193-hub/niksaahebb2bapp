// =============================================================================
// shell.js — the shared header (brand, navigation, user, sign-out) used by the
// restaurant, admin and delivery apps. Each app passes its own nav links.
// =============================================================================

import { html, mount, $, on } from './ui.js';
import { signOut } from './auth.js';
import { config } from './config.js';

/**
 * Render the header into <header id="app-header"> .
 *   renderShell({ me, subtitle: 'Admin', links: [{ href: '#orders', label: 'Orders' }] })
 * Returns { setBadge(href, count), setActive(href) }.
 */
export function renderShell({ me, subtitle, links = [], extra = '' }) {
  const host = $('#app-header');
  mount(host, html`
    <a class="brand" href="./">
      <span class="brand-mark">F</span>
      <span>${config.appName}</span>
      <span class="brand-sub">${subtitle}</span>
    </a>
    <nav class="app-nav" aria-label="Main">
      ${links.map((l) => html`<a class="nav-link" href="${l.href}" data-href="${l.href}">${l.label}<span class="nav-badge" hidden></span></a>`)}
    </nav>
    <div class="header-end">
      ${extra}
      <span class="header-user small muted">${me.profile.full_name || me.user.email}</span>
      <button class="btn small" id="sign-out">Sign out</button>
    </div>`);
  on(host, 'click', '#sign-out', () => signOut(me.profile.role));

  return {
    setActive(href) {
      host.querySelectorAll('.nav-link').forEach((a) => {
        if (a.dataset.href === href) {
          a.setAttribute('aria-current', 'page');
          // The menu scrolls sideways once there are many modules; keep the active one visible.
          a.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
        } else a.removeAttribute('aria-current');
      });
    },
    setBadge(href, count) {
      const badge = host.querySelector(`.nav-link[data-href="${href}"] .nav-badge`);
      if (!badge) return;
      badge.textContent = count;
      badge.hidden = !count;
    },
  };
}

/**
 * Minimal hash router. routes: { '#orders': renderFn }. renderFn(container)
 * may be async. Unknown hashes fall back to `fallback`.
 *
 * Module-level ref to the active hashchange listener so we can remove it when
 * startRouter is called again (e.g. across test runs where importFresh re-runs
 * main.js but shell.js is a cached static import shared across all invocations).
 */
let _removeCurrentListener = null;

export function startRouter({ container, routes, fallback, onRoute }) {
  if (_removeCurrentListener) { _removeCurrentListener(); _removeCurrentListener = null; }

  // Prevent a hashchange event that fires during the initial go() call from
  // starting a second concurrent render (race condition visible in tests where
  // `document.defaultView.location.hash` is set before importFresh, which causes
  // jsdom to fire a hashchange event while go() is already awaiting a route render).
  let _rendering = false;

  async function go() {
    if (_rendering) return;
    _rendering = true;
    try {
      // Exact match first; a route key ending in "/" matches a prefix and gets the rest
      // as a parameter ('#product/' → '#product/abc' → 'abc').
      const key = routes[location.hash] ? location.hash
        : Object.keys(routes).find((k) => k.endsWith('/') && location.hash.startsWith(k)) ?? fallback;
      const param = key.endsWith('/') ? decodeURIComponent(location.hash.slice(key.length)) : undefined;
      onRoute?.(key);
      mount(container, html`<div class="loading"><span class="spinner"></span> Loading…</div>`);
      try {
        await routes[key](container, param);
      } catch (error) {
        console.error(error);
        mount(container, html`<div class="banner error">${error.message || 'Failed to load this page.'}</div>`);
      }
    } finally {
      _rendering = false;
    }
  }
  window.addEventListener('hashchange', go);
  _removeCurrentListener = () => window.removeEventListener('hashchange', go);
  return go();
}
