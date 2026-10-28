// =============================================================================
// page.js — renders one public content page (About, Terms, Privacy, Refund
// policy…) from content_pages by ?slug=…, plus the shared footer (company
// details, page links, contact) from support_channels() and content_pages.
// Migration 019; edited under Admin → Settings → Website.
// =============================================================================

import { html, mount, $, formatDate } from '../core/ui.js';
import { getContentPage, listContentPages, getSupportChannels } from '../core/api.js';
import { telHref, whatsappHref } from '../core/notify.js';

/** Plain text → headings ("## ") and paragraphs (blank-line separated). Exported for the unit test. */
export function renderBody(text) {
  return String(text ?? '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
    .map((block) => (block.startsWith('## ') ? html`<h2>${block.slice(3).trim()}</h2>` : html`<p>${block}</p>`));
}

/** Footer pieces shared with the home page: links to published pages and the contact block. */
export async function fillFooter() {
  const [pages, ch] = await Promise.all([listContentPages().catch(() => []), getSupportChannels().catch(() => null)]);
  const linked = pages.filter((p) => p.is_published && p.show_in_footer);
  const pagesEl = $('#footer-pages');
  if (pagesEl && linked.length) mount(pagesEl, html`<h4>Company</h4>${linked.map((p) => html`<a href="page.html?slug=${p.slug}">${p.title}</a>`)}`);
  const contactEl = $('#footer-contact');
  if (contactEl && ch && (ch.phone || ch.email || ch.whatsapp)) {
    mount(contactEl, html`<h4>Contact</h4>
      ${ch.phone ? html`<a href="${telHref(ch.phone) ?? '#'}">${ch.phone}</a>` : ''}
      ${ch.whatsapp ? html`<a href="${whatsappHref(ch.whatsapp)}" target="_blank" rel="noopener">WhatsApp us</a>` : ''}
      ${ch.email ? html`<a href="mailto:${ch.email}">${ch.email}</a>` : ''}`);
  }
  const companyEl = $('#footer-company');
  if (companyEl && ch) mount(companyEl, html`${ch.name ?? ''}${ch.address ? html`<br>${ch.address}` : ''}${ch.fssai ? html`<br>FSSAI Lic. No. ${ch.fssai}` : ''}${ch.gstin ? html` · GSTIN ${ch.gstin}` : ''}`);
  return ch;
}

async function main() {
  const slug = new URLSearchParams(location.search).get('slug') || 'about';
  const root = $('#page');
  const [page] = await Promise.all([getContentPage(slug).catch(() => null), fillFooter()]);
  if (!page) {
    mount(root, html`<h1>Page not found</h1><p>There is no page at <code>${slug}</code>. <a href="./">Back to the home page</a>.</p>`);
    return;
  }
  document.title = `${page.title} — Fresh Supply`;
  // A sector page (slug sector-<code>, migration 020) ends with a register button that pre-selects the sector.
  const sectorCode = slug.startsWith('sector-') ? slug.slice(7) : null;
  mount(root, html`<h1>${page.title}</h1>${renderBody(page.body)}
    ${sectorCode ? html`<p style="margin-top:var(--space-5)"><a class="btn primary large" href="restaurant/login.html#register&sector=${sectorCode}">Register your business</a> <a class="btn large" href="restaurant/login.html">Partner login</a></p>` : ''}
    <p class="updated">Last updated ${formatDate(page.updated_at)}</p>`);
}

if ($('#page')) main().catch((error) => { console.error(error); mount($('#page'), html`<p class="muted">This page is unavailable right now.</p>`); });
