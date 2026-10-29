// =============================================================================
// ui.js — small DOM / formatting helpers shared by every page.
//
// SECURITY: build markup ONLY with the `html` tagged template. It escapes every
// interpolated value, so a product named "<img onerror=...>" is shown as text.
// Use raw() only for markup YOU generated (e.g. nested html`` results are safe
// automatically; raw is for rare cases such as pre-built SVG strings).
// =============================================================================

import { config } from './config.js';

// ---------- Escaping & templating -------------------------------------------

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for safe use inside HTML content or attribute values. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Mark a string as already-safe HTML. Use sparingly. */
export function raw(value) { return new SafeHtml(String(value)); }

function render(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

/** Tagged template: html`<p>${userText}</p>` — interpolations are escaped. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += render(value) + strings[i + 1]; });
  return new SafeHtml(out);
}

// ---------- DOM helpers ------------------------------------------------------

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Replace an element's content with html`` output. */
export function mount(element, template) {
  element.innerHTML = template instanceof SafeHtml ? template.value : escapeHtml(template);
  return element;
}

/**
 * Event delegation: call handler(event, matchedElement) when an element
 * matching `selector` inside `root` receives `type`. Survives re-rendering.
 */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (event) => {
    const match = event.target.closest?.(selector);
    if (match && root.contains(match)) handler(event, match);
  });
}

// ---------- Formatting -------------------------------------------------------

const moneyFormat = new Intl.NumberFormat(config.locale, {
  style: 'currency', currency: config.currency, minimumFractionDigits: 2,
});

/** 1234.5 -> "₹1,234.50" */
export function formatINR(amount) { return moneyFormat.format(Number(amount) || 0); }

/** Plain quantity: 2.50 -> "2.5" */
export function formatQty(qty) { return String(Number(qty)); }

const dateTimeFormat = new Intl.DateTimeFormat(config.locale, {
  timeZone: config.timeZone, day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(config.locale, {
  timeZone: config.timeZone, day: '2-digit', month: 'short', year: 'numeric',
});

export function formatDateTime(iso) { return iso ? dateTimeFormat.format(new Date(iso)) : '—'; }
export function formatDate(iso) { return iso ? dateFormat.format(new Date(iso)) : '—'; }

export const STATUS_LABELS = Object.freeze({
  placed: 'Placed',
  confirmed: 'Confirmed',
  packed: 'Packed',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  pending: 'Pending approval',
  approved: 'Approved',
  suspended: 'Suspended',
});

/** Coloured pill for an order or restaurant status (classes in components.css). */
export function statusBadge(status) {
  return html`<span class="badge ${status}">${STATUS_LABELS[status] ?? status}</span>`;
}

// ---------- Toasts -----------------------------------------------------------

function toastHost() {
  let host = $('#toast-region');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-region';
    host.className = 'toast-region';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  return host;
}

/** Show a short message. kind: 'info' | 'success' | 'error'. */
export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastHost().append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

/** Turn any thrown error into a friendly toast. */
export function reportError(error) {
  console.error(error);
  toast(error?.message || 'Something went wrong. Please try again.', 'error');
}

// ---------- Modal & confirm --------------------------------------------------

/**
 * Open a modal dialog. `content` is html``. Returns { el, close }.
 * Closes on Escape or backdrop click.
 */
export function openModal(content, { title = '', wide = false } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay center';
  overlay.innerHTML = html`
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-head spread">
        <h2>${title}</h2>
        <button class="icon-btn" data-close aria-label="Close">×</button>
      </div>
      <div class="modal-body">${content}</div>
    </div>`.toString();
  document.body.append(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) close();
  });
  return { el: overlay.querySelector('.modal-body'), close };
}

/** Promise-based confirm dialog: `if (await confirmDialog('Cancel order?')) ...` */
export function confirmDialog(message, { confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const { el, close } = openModal(html`
      <p>${message}</p>
      <div class="row" style="justify-content:flex-end;margin-top:var(--space-5)">
        <button class="btn" data-no>Back</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${confirmText}</button>
      </div>`, { title: 'Please confirm' });
    el.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
    el.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
  });
}

/** Disable a button while an async action runs, always re-enabling after. */
export async function withBusy(button, action) {
  button.disabled = true;
  try { return await action(); } finally { button.disabled = false; }
}
