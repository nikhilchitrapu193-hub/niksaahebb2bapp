// =============================================================================
// benchmarks.js — Pricing → Benchmarks: today's market rates.
//
// The morning routine: pick a source (Rythu Bazaar board, NECC, DoCA, METRO…)
// and a date, type the rate next to each product, Save. A CSV upload does the
// same in bulk (columns: sku, price, and optionally source, date, market).
// Rates feed the price board (benchmark cap, "fixed amount over benchmark")
// and are shown to customers as the struck-through "market rate" with the
// source and date. Sources themselves are managed in the dialog at the top.
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listBenchmarkSources, saveBenchmarkSource, listBenchmarkPrices, saveBenchmarkPrices, listProducts } from '../../core/api.js';
import { parseCsv, readTextFile } from '../../core/csv.js';
import { can } from '../../core/permissions.js';
import { pricingTabs, todayIso } from './price-board.js';

/**
 * Turn parsed CSV rows into benchmark rows. Pure (unit-tested).
 * products: [{ id, sku }], sources: [{ id, code }], defaults: { source_id, price_date }.
 * Returns { rows, problems: ['line 3: unknown SKU X-9', …] }.
 */
export function csvToBenchmarks(parsed, products, sources, defaults) {
  const bySku = Object.fromEntries(products.map((p) => [p.sku.toLowerCase(), p.id]));
  const byCode = Object.fromEntries(sources.map((s) => [s.code.toLowerCase(), s.id]));
  const rows = [];
  const problems = [];
  parsed.rows.forEach((r, n) => {
    const line = n + 2;
    const productId = bySku[(r.sku ?? '').toLowerCase()];
    const sourceId = r.source ? byCode[r.source.toLowerCase()] : defaults.source_id;
    const price = Number(r.price);
    const date = r.date || defaults.price_date;
    if (!productId) { problems.push(`line ${line}: unknown SKU "${r.sku ?? ''}"`); return; }
    if (!sourceId) { problems.push(`line ${line}: unknown source "${r.source ?? ''}"`); return; }
    if (!(price >= 0) || r.price === '' || r.price == null) { problems.push(`line ${line}: price "${r.price ?? ''}" is not a number`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { problems.push(`line ${line}: date "${date}" must be YYYY-MM-DD`); return; }
    rows.push({ source_id: sourceId, product_id: productId, price_date: date, price, market: r.market || null });
  });
  return { rows, problems };
}

export async function renderBenchmarks(container, me) {
  const editable = can(me, 'pricing', 'edit');
  let sourceId = '';
  let date = todayIso();
  let [sources, products, prices] = await Promise.all([listBenchmarkSources(), listProducts(), listBenchmarkPrices({ limit: 2000 })]);
  sourceId = sources.find((s) => s.is_active)?.id ?? '';
  let search = '';

  async function reload() { [sources, prices] = await Promise.all([listBenchmarkSources(), listBenchmarkPrices({ limit: 2000 })]); draw(); }

  const entry = (productId) => prices.find((p) => p.source_id === sourceId && p.product_id === productId && p.price_date === date);
  const latest = (productId) => prices.filter((p) => p.source_id === sourceId && p.product_id === productId).sort((a, b) => (a.price_date < b.price_date ? 1 : -1))[0];

  function draw() {
    const term = search.trim().toLowerCase();
    const list = products.filter((p) => p.is_active && (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)));
    const source = sources.find((s) => s.id === sourceId);
    const entered = list.filter((p) => entry(p.id)).length;
    mount(container, html`
      <div class="page-head"><div><h1>Benchmarks</h1><p>Market rates per source and day. ${source ? `${entered} of ${list.length} products have a ${source.name} rate for ${formatDate(date)}.` : 'Add a source to start.'}</p></div>
        <div class="row">${editable ? html`<button class="btn" id="sources">Sources</button><button class="btn" id="upload">Upload CSV</button>` : ''}</div></div>
      ${pricingTabs('#benchmarks')}
      <div class="toolbar">
        <select class="select" id="source">${sources.map((s) => html`<option value="${s.id}" ${s.id === sourceId ? 'selected' : ''}>${s.name}${s.is_active ? '' : ' (inactive)'}</option>`)}</select>
        <input class="input" id="date" type="date" value="${date}" max="${todayIso()}">
        <input class="input search" id="search" type="search" placeholder="Search name or SKU…" value="${search}">
        ${editable ? html`<button class="btn primary" id="save-grid">Save rates</button>` : ''}
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="right">Our price</th><th class="right">Rate on ${formatDate(date)}</th><th>Market / note</th><th class="right">Last entered</th></tr></thead>
        <tbody>${list.map((p) => { const e = entry(p.id); const l = latest(p.id); return html`<tr data-id="${p.id}">
          <td><strong>${p.name}</strong><div class="muted tiny">${p.sku} · per ${p.unit}</div></td>
          <td class="right num">${formatINR(p.price)}</td>
          <td class="right">${editable ? html`<input class="input small num right" type="number" min="0" step="0.01" data-rate="${p.id}" value="${e?.price ?? ''}" style="width:100px" aria-label="Rate for ${p.name}">` : html`<span class="num">${e ? formatINR(e.price) : '—'}</span>`}</td>
          <td>${editable ? html`<input class="input small" data-market="${p.id}" value="${e?.market ?? ''}" maxlength="60" placeholder="e.g. MVP Colony" style="width:140px" aria-label="Market for ${p.name}">` : html`${e?.market ?? ''}`}</td>
          <td class="right muted small">${l ? html`${formatINR(l.price)} on ${formatDate(l.price_date)}` : 'never'}</td></tr>`; })}</tbody></table></div></div>
      <p class="muted small" style="margin-top:var(--space-3)">Rates are per selling unit (${products[0]?.unit ?? 'kg'}, tray, tin…). Entering a product again for the same source and day overwrites the earlier number.</p>`);
    $('#search', container).oninput = (e) => { search = e.target.value; draw(); $('#search', container).focus(); };
  }

  on(container, 'change', '#source', (_e, el) => { sourceId = el.value; draw(); });
  on(container, 'change', '#date', (_e, el) => { date = el.value || todayIso(); draw(); });
  on(container, 'click', '#save-grid', async (_e, button) => {
    const rows = [];
    for (const input of container.querySelectorAll('[data-rate]')) {
      if (input.value === '') continue;
      const market = container.querySelector(`[data-market="${input.dataset.rate}"]`)?.value.trim() || null;
      rows.push({ source_id: sourceId, product_id: input.dataset.rate, price_date: date, price: Number(input.value), market });
    }
    if (!rows.length) { toast('Type at least one rate', 'error'); return; }
    try {
      await withBusy(button, () => saveBenchmarkPrices(rows));
      toast(`${rows.length} rate${rows.length === 1 ? '' : 's'} saved`, 'success');
      await reload();
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '#sources', () => sourceManager(sources, reload));
  on(container, 'click', '#upload', () => uploadDialog({ products, sources, sourceId, date, onSaved: reload }));

  draw();
}

function sourceManager(sources, onChanged) {
  const { el } = openModal(html`<div id="src"></div>`, { title: 'Benchmark sources', wide: true });
  const host = $('#src', el);
  let list = sources;
  function draw() {
    mount(host, html`
      ${list.map((s) => html`<div class="line" data-id="${s.id}">
        <input class="input small" value="${s.name}" data-name aria-label="Name" style="flex:2">
        <input class="input small" value="${s.url ?? ''}" data-url placeholder="https://…" aria-label="Link" style="flex:2">
        <label class="check small"><input type="checkbox" data-active ${s.is_active ? 'checked' : ''}> Active</label>
        <button class="btn small" data-save>Save</button></div>`)}
      <form id="add-src" class="row" style="margin-top:var(--space-4)">
        <input class="input" name="code" placeholder="code, e.g. harbour_vizag" pattern="[a-z_]+" required maxlength="40">
        <input class="input" name="name" placeholder="Name shown to customers" required maxlength="80">
        <button class="btn primary" type="submit">Add source</button></form>`);
  }
  async function refresh() { list = await listBenchmarkSources(); draw(); onChanged(); }
  on(host, 'click', '[data-save]', async (_e, b) => {
    const row = b.closest('[data-id]');
    const s = list.find((x) => x.id === row.dataset.id);
    try { await saveBenchmarkSource({ ...s, name: $('[data-name]', row).value, url: $('[data-url]', row).value, is_active: $('[data-active]', row).checked }); toast('Saved', 'success'); await refresh(); }
    catch (error) { reportError(error); }
  });
  on(host, 'submit', '#add-src', async (event, form) => {
    event.preventDefault();
    try { await saveBenchmarkSource({ code: form.elements.code.value, name: form.elements.name.value, sort_order: (list.at(-1)?.sort_order ?? 0) + 10 }); await refresh(); }
    catch (error) { reportError(error); }
  });
  draw();
}

function uploadDialog({ products, sources, sourceId, date, onSaved }) {
  let prepared = { rows: [], problems: [] };
  const { el, close } = openModal(html`
    <div class="stack">
      <p>CSV columns: <code>sku,price</code> and optionally <code>source,date,market</code>. Missing source or date use the choices below.</p>
      <div class="form-grid">
        <label class="field"><span class="label">Source for rows without one</span><select class="select" id="csv-source">${sources.map((s) => html`<option value="${s.id}" ${s.id === sourceId ? 'selected' : ''}>${s.name} (${s.code})</option>`)}</select></label>
        <label class="field"><span class="label">Date for rows without one</span><input class="input" id="csv-date" type="date" value="${date}"></label>
        <label class="field span-2"><span class="label">File</span><input type="file" id="csv-file" accept=".csv,text/csv"></label>
      </div>
      <div id="csv-preview"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="csv-save" disabled>Save rates</button></div>
    </div>`, { title: 'Upload benchmark rates', wide: true });

  async function prepare() {
    const file = $('#csv-file', el).files[0];
    if (!file) return;
    const parsed = parseCsv(await readTextFile(file));
    prepared = csvToBenchmarks(parsed, products, sources, { source_id: $('#csv-source', el).value, price_date: $('#csv-date', el).value });
    mount($('#csv-preview', el), html`
      <p><strong>${prepared.rows.length}</strong> rate${prepared.rows.length === 1 ? '' : 's'} ready${prepared.problems.length ? html`, <strong>${prepared.problems.length}</strong> line${prepared.problems.length === 1 ? '' : 's'} skipped` : ''}.</p>
      ${prepared.problems.length ? html`<ul class="diff">${prepared.problems.slice(0, 10).map((p) => html`<li class="old">${p}</li>`)}</ul>` : ''}`);
    $('#csv-save', el).disabled = prepared.rows.length === 0;
  }
  $('#csv-file', el).onchange = () => prepare().catch(reportError);
  $('#csv-source', el).onchange = () => prepare().catch(reportError);
  $('#csv-date', el).onchange = () => prepare().catch(reportError);
  $('#csv-save', el).onclick = async () => {
    try {
      await withBusy($('#csv-save', el), () => saveBenchmarkPrices(prepared.rows));
      toast(`${prepared.rows.length} rates saved`, 'success');
      close(); onSaved();
    } catch (error) { reportError(error); }
  };
}
