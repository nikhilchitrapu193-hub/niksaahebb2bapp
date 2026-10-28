// =============================================================================
// website.js — Settings → Website (migration 019): the public pages (About,
// Terms, Privacy, Refund policy, anything else) rendered by page.html, the
// footer links, and the SEO title / description of the home page.
// Plain text with blank lines between paragraphs; a line starting with "## "
// becomes a heading. Editing needs settings:edit.
// =============================================================================

import { html, mount, on, $, formatDate, openModal, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listContentPages, saveContentPage, deleteContentPage, getCompanySettings, saveCompanySettings } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { webRoot } from '../../core/config.js';
import { settingsTabs } from './settings.js';

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export async function renderWebsite(container, me) {
  const canEdit = can(me, 'settings', 'edit');
  let pages = [];
  let settings = {};

  async function load() { [pages, settings] = await Promise.all([listContentPages(), getCompanySettings()]); draw(); }

  function draw() {
    const ro = canEdit ? '' : 'disabled';
    mount(container, html`
      <div class="page-head"><div><h1>Website</h1><p>Pages on the public site, footer links and how the home page appears in search results.</p></div>
        ${canEdit ? html`<button class="btn primary" id="new-page">New page</button>` : ''}</div>
      ${settingsTabs(me, '#website')}
      <form class="card card-pad stack" id="seo-form" novalidate>
        <h2>Search listing (SEO)</h2>
        <div class="form-grid">
          <label class="field span-2"><span class="label">Home page title</span><input class="input" name="seo_title" maxlength="70" value="${settings.seo_title ?? ''}" ${ro}><span class="hint">Shown in the browser tab and as the headline in Google. Under 60 characters is safest.</span></label>
          <label class="field span-2"><span class="label">Description</span><textarea class="textarea" name="seo_description" rows="2" maxlength="160" ${ro}>${settings.seo_description ?? ''}</textarea><span class="hint">The two lines under the headline in search results (up to 160 characters).</span></label>
        </div>
        ${canEdit ? html`<div><button class="btn primary" type="submit">Save</button></div>` : ''}
        <p class="muted small"><code>robots.txt</code> and <code>sitemap.xml</code> sit beside <code>index.html</code>; add new pages to the sitemap when you publish them.</p>
      </form>
      <h2 style="margin:var(--space-6) 0 var(--space-3)">Pages</h2>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Title</th><th>Address</th><th>Footer</th><th>Published</th><th>Updated</th><th></th></tr></thead>
        <tbody>${pages.length === 0 ? html`<tr><td colspan="7"><div class="empty">No pages yet.</div></td></tr>` : pages.map((p) => html`<tr>
          <td class="muted num">${p.sort_order}</td>
          <td><strong>${p.title}</strong></td>
          <td class="small"><a href="${webRoot}page.html?slug=${p.slug}" target="_blank" rel="noopener">page.html?slug=${p.slug}</a></td>
          <td>${p.show_in_footer ? 'yes' : html`<span class="muted">no</span>`}</td>
          <td>${p.is_published ? html`<span class="badge delivered">published</span>` : html`<span class="badge inactive">draft</span>`}</td>
          <td class="muted small nowrap">${formatDate(p.updated_at)}</td>
          <td class="right nowrap"><button class="btn small" data-edit="${p.slug}">${canEdit ? 'Edit' : 'View'}</button>${canEdit ? html`<button class="btn ghost small" data-delete="${p.slug}">Delete</button>` : ''}</td></tr>`)}</tbody></table></div></div>`);
  }

  function edit(p) {
    const isNew = !p.slug;
    const ro = canEdit ? '' : 'disabled';
    const { el, close } = openModal(html`<form id="page" class="stack" novalidate>
      <label class="field"><span class="label">Title</span><input class="input" name="title" maxlength="160" value="${p.title ?? ''}" required ${ro}></label>
      <div class="form-grid">
        <label class="field"><span class="label">Address (slug)</span><input class="input" name="slug" maxlength="60" value="${p.slug ?? ''}" pattern="[a-z0-9-]+" ${isNew && canEdit ? '' : 'disabled'}><span class="hint">page.html?slug=…</span></label>
        <label class="field"><span class="label">Order</span><input class="input" name="sort_order" type="number" min="0" step="1" value="${p.sort_order ?? 50}" ${ro}></label>
        <label class="check"><input type="checkbox" name="is_published" ${p.is_published !== false ? 'checked' : ''} ${ro}> Published</label>
        <label class="check"><input type="checkbox" name="show_in_footer" ${p.show_in_footer !== false ? 'checked' : ''} ${ro}> Link in the website footer</label>
      </div>
      <label class="field"><span class="label">Text</span><textarea class="textarea" name="body" rows="14" maxlength="20000" required ${ro}>${p.body ?? ''}</textarea><span class="hint">Blank line = new paragraph. Start a line with "## " for a heading.</span></label>
      <p class="form-error" id="page-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Close</button>${canEdit ? html`<button class="btn primary" type="submit">Save</button>` : ''}</div>
    </form>`, { title: isNew ? 'New page' : p.title, wide: true });
    const form = $('#page', el);
    form.elements.title.addEventListener('input', () => { if (isNew && !form.elements.slug.dataset.touched) form.elements.slug.value = slugify(form.elements.title.value); });
    form.elements.slug.addEventListener('input', () => { form.elements.slug.dataset.touched = '1'; });
    form.onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      v.slug = isNew ? slugify(v.slug || v.title) : p.slug;
      v.is_published = form.elements.is_published.checked; v.show_in_footer = form.elements.show_in_footer.checked;
      if (!v.title.trim() || !v.body.trim() || !v.slug) { $('#page-error', el).textContent = 'Title, address and text are required.'; return; }
      try { await withBusy($('button[type="submit"]', form), () => saveContentPage(v)); toast('Page saved', 'success'); close(); await load(); }
      catch (error) { $('#page-error', el).textContent = error.message; }
    };
  }

  on(container, 'submit', '#seo-form', async (event, form) => {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try { await withBusy($('button[type="submit"]', form), () => saveCompanySettings({ seo_title: v.seo_title, seo_description: v.seo_description })); toast('Saved', 'success'); }
    catch (error) { reportError(error); }
  });
  on(container, 'click', '#new-page', () => edit({ sort_order: (pages.at(-1)?.sort_order ?? 0) + 10, is_published: true, show_in_footer: true }));
  on(container, 'click', '[data-edit]', (_e, el) => edit(pages.find((p) => p.slug === el.dataset.edit)));
  on(container, 'click', '[data-delete]', async (_e, el) => {
    if (!(await confirmDialog('Delete this page? Links to it will stop working.', { confirmText: 'Delete', danger: true }))) return;
    try { await deleteContentPage(el.dataset.delete); toast('Deleted', 'success'); await load(); } catch (error) { reportError(error); }
  });

  await load();
}
