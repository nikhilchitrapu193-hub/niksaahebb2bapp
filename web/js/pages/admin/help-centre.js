// =============================================================================
// help-centre.js — Settings → Help centre (migration 018). The articles shown
// under Help in the customer app, the driver app's tips, and the FAQ on the
// public website (audience = public). Plain text with blank lines between
// paragraphs; no HTML. Editing needs settings:edit.
// =============================================================================

import { html, mount, on, $, formatDate, openModal, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { listHelpArticles, saveHelpArticle, deleteHelpArticle } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { HELP_AUDIENCES } from '../../core/config.js';
import { settingsTabs } from './settings.js';

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export async function renderHelpCentre(container, me) {
  const canEdit = can(me, 'settings', 'edit');
  let articles = [];

  async function load() { articles = await listHelpArticles(); draw(); }

  function draw() {
    mount(container, html`
      <div class="page-head"><div><h1>Help centre</h1><p>${articles.length} articles · shown under Help in the apps and as the website FAQ.</p></div>
        ${canEdit ? html`<button class="btn primary" id="new-article">New article</button>` : ''}</div>
      ${settingsTabs(me, '#help-centre')}
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Title</th><th>Audience</th><th>Published</th><th>Updated</th><th></th></tr></thead>
        <tbody>${articles.length === 0 ? html`<tr><td colspan="6"><div class="empty">No articles yet.</div></td></tr>` : articles.map((a) => html`<tr>
          <td class="muted num">${a.sort_order}</td>
          <td><strong>${a.title}</strong><div class="muted tiny">${a.slug}</div></td>
          <td class="small">${HELP_AUDIENCES[a.audience] ?? a.audience}</td>
          <td>${a.is_published ? html`<span class="badge delivered">published</span>` : html`<span class="badge inactive">draft</span>`}</td>
          <td class="muted small nowrap">${formatDate(a.updated_at)}</td>
          <td class="right nowrap"><button class="btn small" data-edit="${a.id}">${canEdit ? 'Edit' : 'View'}</button>${canEdit ? html`<button class="btn ghost small" data-delete="${a.id}">Delete</button>` : ''}</td></tr>`)}</tbody></table></div></div>`);
  }

  function edit(a) {
    const isNew = !a.id;
    const ro = canEdit ? '' : 'disabled';
    const { el, close } = openModal(html`<form id="article" class="stack" novalidate>
      <label class="field"><span class="label">Title</span><input class="input" name="title" maxlength="160" value="${a.title ?? ''}" required ${ro}></label>
      <div class="form-grid">
        <label class="field"><span class="label">Slug (web address)</span><input class="input" name="slug" maxlength="60" value="${a.slug ?? ''}" pattern="[a-z0-9-]+" ${ro}><span class="hint">Letters, digits and dashes</span></label>
        <label class="field"><span class="label">Audience</span><select class="select" name="audience" ${ro}>${Object.entries(HELP_AUDIENCES).map(([k, v]) => html`<option value="${k}" ${k === (a.audience ?? 'customer') ? 'selected' : ''}>${v}</option>`)}</select></label>
        <label class="field"><span class="label">Order</span><input class="input" name="sort_order" type="number" min="0" step="1" value="${a.sort_order ?? 10}" ${ro}></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="is_published" ${a.is_published !== false ? 'checked' : ''} ${ro}> Published</label>
      </div>
      <label class="field"><span class="label">Text</span><textarea class="textarea" name="body" rows="10" maxlength="8000" required ${ro}>${a.body ?? ''}</textarea><span class="hint">Plain text. Leave a blank line between paragraphs.</span></label>
      <p class="form-error" id="article-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Close</button>${canEdit ? html`<button class="btn primary" type="submit">Save</button>` : ''}</div>
    </form>`, { title: isNew ? 'New article' : a.title, wide: true });
    const form = $('#article', el);
    form.elements.title.addEventListener('input', () => { if (isNew && !form.elements.slug.dataset.touched) form.elements.slug.value = slugify(form.elements.title.value); });
    form.elements.slug.addEventListener('input', () => { form.elements.slug.dataset.touched = '1'; });
    form.onsubmit = async (event) => {
      event.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      v.is_published = form.elements.is_published.checked;
      v.slug = v.slug ? slugify(v.slug) : slugify(v.title);
      if (!v.title.trim() || !v.body.trim()) { $('#article-error', el).textContent = 'Title and text are required.'; return; }
      try { await withBusy($('button[type="submit"]', form), () => saveHelpArticle({ ...a, ...v })); toast('Article saved', 'success'); close(); await load(); }
      catch (error) { $('#article-error', el).textContent = error.message; }
    };
  }

  on(container, 'click', '#new-article', () => edit({ audience: 'customer', sort_order: (articles.at(-1)?.sort_order ?? 0) + 10, is_published: true }));
  on(container, 'click', '[data-edit]', (_e, el) => edit(articles.find((a) => a.id === el.dataset.edit)));
  on(container, 'click', '[data-delete]', async (_e, el) => {
    if (!(await confirmDialog('Delete this article?', { confirmText: 'Delete', danger: true }))) return;
    try { await deleteHelpArticle(el.dataset.delete); toast('Deleted', 'success'); await load(); } catch (error) { reportError(error); }
  });

  await load();
}
