// =============================================================================
// price-board.js — the daily price board (Pricing → Price board).
//
// One row per product: today's cost, landed cost, markup, the suggested price,
// the current price, the benchmark and its age, margin, and warning flags.
// Staff can type a supplier quote or a different price straight into the row;
// the numbers recalculate instantly with web/js/core/pricing.js (the same
// formula as the database). "Publish" sends the chosen rows to apply_prices(),
// which recomputes server-side, applies the margin guard and writes the price
// and the history. A date-time makes it a scheduled change instead.
//
// The row's "…" opens a drawer: every variable for this product (override),
// the cost sources, the benchmark, the price history chart and the
// "explain this price" breakdown — this is the landed-cost / yield / margin
// calculator from the build list, on the product it applies to.
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listPriceBoard, listCategories, applyPrices, publishDuePrices, listScheduledPrices, cancelScheduledPrice,
         saveSupplierQuote, saveProductPricing, listProductPricing, listBenchmarkSources, listPriceHistory } from '../../core/api.js';
import { computePrice, marginOf, FLAG_LABELS, sparklinePath } from '../../core/pricing.js';
import { PRICING_MODES, COST_METHODS, PACK_UNITS } from '../../core/config.js';
import { can } from '../../core/permissions.js';
import { downloadCsv } from '../../core/csv.js';

/** Shared tab strip for the three pricing screens. */
export function pricingTabs(active) {
  const tabs = [
    { href: '#pricing', label: 'Price board' },
    { href: '#pricing-rules', label: 'Rules' },
    { href: '#benchmarks', label: 'Benchmarks' },
  ];
  return html`<div class="tabs" role="tablist">
    ${tabs.map((t) => html`<a role="tab" href="${t.href}" aria-selected="${String(t.href === active)}">${t.label}</a>`)}
  </div>`;
}

/** Today in the business time zone as YYYY-MM-DD (benchmarks and quotes are per day). */
export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Flag pills for a row. */
function flagPills(flags) {
  return html`${(flags ?? []).map((f) => {
    const meta = FLAG_LABELS[f] ?? { label: f, tone: 'info' };
    return html`<span class="flag ${meta.tone}">${meta.label}</span>`;
  })}`;
}

const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
const money = (v) => (v == null ? '—' : formatINR(v));

export async function renderPriceBoard(container, me) {
  const canEdit = can(me, 'pricing', 'edit');
  const canApprove = can(me, 'pricing', 'approve');
  const canExport = can(me, 'pricing', 'export');
  let categoryId = '';
  let flagFilter = '';
  let search = '';
  let rows = [];            // board rows from the database (inputs + result)
  let edits = {};           // product_id → { price?, supplier_quote? } typed on screen
  let selected = new Set();
  let scheduled = [];
  let categories = [];

  // Scheduled prices whose time has come go live now (pg_cron does this too).
  try { await publishDuePrices(); } catch (error) { console.error(error); }

  async function load() {
    [rows, categories, scheduled] = await Promise.all([listPriceBoard(categoryId), listCategories(), listScheduledPrices()]);
    edits = {};
    selected = new Set();
    draw();
  }

  /** The row with any on-screen edits applied and the price recomputed locally. */
  function effective(row) {
    const e = edits[row.product_id] ?? {};
    const inputs = e.supplier_quote !== undefined ? { ...row, supplier_quote: e.supplier_quote, cost_method: 'quote' } : row;
    const calc = computePrice(inputs);
    const price = e.price !== undefined && e.price !== '' ? Number(e.price) : calc.suggested_price;
    const margin = marginOf(price, calc.landed_cost);
    const flags = [...calc.flags];
    if (e.price !== undefined && price != null && calc.landed_cost != null) {
      // The typed price replaces the suggestion, so re-check the guard on it.
      const idx = flags.findIndex((f) => f === 'below_cost' || f === 'below_min_markup');
      if (idx >= 0) flags.splice(idx, 1);
      if (price < calc.landed_cost) flags.push('below_cost');
      else if (margin.markupPct != null && margin.markupPct < Number(row.min_markup_pct ?? 0)) flags.push('below_min_markup');
    }
    return { ...row, ...calc, flags, price, margin, edited: e.price !== undefined || e.supplier_quote !== undefined };
  }

  function visibleRows() {
    const term = search.trim().toLowerCase();
    return rows.map(effective).filter((r) =>
      (!term || r.name.toLowerCase().includes(term) || r.sku.toLowerCase().includes(term)) &&
      (!flagFilter || r.flags.includes(flagFilter) || (flagFilter === 'changed' && r.price !== Number(r.current_price))));
  }

  function draw() {
    const list = visibleRows();
    const warn = rows.map(effective);
    const counts = {
      changed: warn.filter((r) => r.price != null && r.price !== Number(r.current_price)).length,
      no_cost: warn.filter((r) => r.flags.includes('no_cost')).length,
      stale: warn.filter((r) => r.flags.includes('stale_benchmark')).length,
      guard: warn.filter((r) => r.flags.includes('below_cost') || r.flags.includes('below_min_markup')).length,
    };
    mount(container, html`
      <div class="page-head"><div><h1>Price board</h1><p>${rows.length} products · ${counts.changed} would change · ${counts.no_cost} without a cost · ${counts.stale} stale benchmarks · ${counts.guard} under the margin guard</p></div>
        <div class="row">
          ${canExport ? html`<button class="btn" id="export">Export CSV</button>` : ''}
          ${canApprove ? html`<button class="btn primary" id="publish" ${selected.size ? '' : 'disabled'}>Publish ${selected.size ? `(${selected.size})` : ''}</button>` : ''}
        </div></div>
      ${pricingTabs('#pricing')}
      ${scheduled.length ? html`<div class="banner info"><div><strong>${scheduled.length} scheduled price change${scheduled.length === 1 ? '' : 's'}</strong> waiting ·
        ${scheduled.slice(0, 3).map((s) => html`${rows.find((r) => r.product_id === s.product_id)?.name ?? 'product'} → ${formatINR(s.price)} on ${formatDate(s.effective_at)}${canApprove ? html` <button class="btn small" data-cancel-sched="${s.id}">cancel</button>` : ''}; `)}
        ${scheduled.length > 3 ? `and ${scheduled.length - 3} more` : ''}</div></div>` : ''}
      <div class="toolbar">
        <input class="input search" id="search" type="search" placeholder="Search name or SKU…" value="${search}">
        <select class="select" id="category"><option value="">All categories</option>
          ${categories.map((c) => html`<option value="${c.id}" ${c.id === categoryId ? 'selected' : ''}>${c.name}</option>`)}</select>
        <select class="select" id="flag"><option value="">All rows</option>
          <option value="changed" ${flagFilter === 'changed' ? 'selected' : ''}>Would change</option>
          ${Object.entries(FLAG_LABELS).map(([k, v]) => html`<option value="${k}" ${flagFilter === k ? 'selected' : ''}>${v.label}</option>`)}</select>
        ${canApprove ? html`<label class="check small"><input type="checkbox" id="select-all" ${list.length && list.every((r) => selected.has(r.product_id)) ? 'checked' : ''}> Select all shown</label>` : ''}
      </div>
      <div class="card"><div class="table-wrap"><table class="table board">
        <thead><tr>
          ${canApprove ? html`<th></th>` : ''}
          <th>Product</th><th class="right">Quote today</th><th class="right">Cost basis</th><th class="right">Landed</th>
          <th class="right">Markup</th><th class="right">Suggested</th><th class="right">Current</th><th class="right">Benchmark</th>
          <th class="right">Margin</th><th>Flags</th><th></th></tr></thead>
        <tbody>${list.length === 0 ? html`<tr><td colspan="12"><div class="empty">No products match.</div></td></tr>` : list.map((r) => html`
          <tr data-id="${r.product_id}" class="${r.edited ? 'edited' : ''}">
            ${canApprove ? html`<td><input type="checkbox" data-select="${r.product_id}" ${selected.has(r.product_id) ? 'checked' : ''} aria-label="Select ${r.name}"></td>` : ''}
            <td class="name"><strong>${r.name}</strong><div class="muted tiny">${r.sku} · per ${r.unit} · ${r.category_name ?? ''} · ${r.rule_source === 'category' ? 'category rule' : 'global rule'}${r.has_override ? ' + override' : ''}</div></td>
            <td class="right">${canEdit ? html`<input class="input small num right" type="number" min="0" step="0.01" data-quote="${r.product_id}" value="${edits[r.product_id]?.supplier_quote ?? r.supplier_quote ?? ''}" style="width:92px" aria-label="Quote for ${r.name}">`
                                      : html`<span class="num">${money(r.supplier_quote)}</span>`}
              ${r.quote_date ? html`<div class="muted tiny">${formatDate(r.quote_date)}</div>` : ''}</td>
            <td class="right num">${money(r.cost_basis)}<div class="muted tiny">${COST_METHODS[r.cost_method]?.label.split(' (')[0] ?? ''}</div></td>
            <td class="right num">${money(r.landed_cost)}</td>
            <td class="right num">${r.pricing_mode === 'rule' ? pct(r.markup_pct) : (PRICING_MODES[r.pricing_mode]?.label ?? r.pricing_mode)}</td>
            <td class="right">${canApprove ? html`<input class="input small num right" type="number" min="0" step="0.01" data-price="${r.product_id}" value="${edits[r.product_id]?.price ?? r.suggested_price ?? ''}" style="width:92px" aria-label="Price for ${r.name}">`
                                         : html`<span class="num">${money(r.price)}</span>`}</td>
            <td class="right num ${r.price != null && r.price !== Number(r.current_price) ? 'changed' : ''}">${money(r.current_price)}</td>
            <td class="right num">${r.benchmark_price != null ? html`${money(r.benchmark_price)}<div class="muted tiny">${r.benchmark_source_name ?? ''} · ${r.benchmark_age_days === 0 ? 'today' : `${r.benchmark_age_days} d ago`}</div>` : html`<span class="muted">—</span>`}</td>
            <td class="right num">${r.margin.amount != null ? html`${money(r.margin.amount)}<div class="muted tiny">${pct(r.margin.pct)} of price</div>` : '—'}</td>
            <td>${flagPills(r.flags)}</td>
            <td class="right"><button class="btn small" data-open="${r.product_id}" title="Explain and override">…</button></td>
          </tr>`)}</tbody></table></div></div>
      <p class="muted small" style="margin-top:var(--space-3)">Landed cost = (cost + transport & handling per kg + packing) × (1 + market fee) × (1 + other costs) ÷ yield ÷ (1 − wastage). Price = landed × (1 + markup), held under benchmark × (1 + cap), rounded to the category step. Change the variables under <a href="#pricing-rules">Rules</a>.</p>`);
    $('#search', container).oninput = (e) => { search = e.target.value; draw(); $('#search', container).focus(); };
  }

  on(container, 'change', '#category', async (_e, el) => { categoryId = el.value; try { await load(); } catch (error) { reportError(error); } });
  on(container, 'change', '#flag', (_e, el) => { flagFilter = el.value; draw(); });
  on(container, 'change', '#select-all', (_e, el) => {
    for (const r of visibleRows()) { if (el.checked) selected.add(r.product_id); else selected.delete(r.product_id); }
    draw();
  });
  on(container, 'change', '[data-select]', (_e, el) => { if (el.checked) selected.add(el.dataset.select); else selected.delete(el.dataset.select); draw(); });

  // Typing a price only marks the row; the quote is saved when the field is left.
  on(container, 'input', '[data-price]', (_e, el) => {
    edits[el.dataset.price] = { ...edits[el.dataset.price], price: el.value };
    selected.add(el.dataset.price);
    refreshRow(el.dataset.price);
  });
  on(container, 'input', '[data-quote]', (_e, el) => {
    edits[el.dataset.quote] = { ...edits[el.dataset.quote], supplier_quote: el.value === '' ? null : Number(el.value) };
    refreshRow(el.dataset.quote);
  });
  on(container, 'change', '[data-quote]', async (_e, el) => {
    try {
      await saveSupplierQuote(el.dataset.quote, el.value, todayIso());
      const row = rows.find((r) => r.product_id === el.dataset.quote);
      if (row) { row.supplier_quote = el.value === '' ? null : Number(el.value); row.quote_date = todayIso(); }
      toast('Quote saved', 'success');
    } catch (error) { reportError(error); }
  });

  /** Redraw one row's computed cells without losing focus in the input being typed in. */
  function refreshRow(productId) {
    const tr = container.querySelector(`tr[data-id="${productId}"]`);
    const row = rows.find((r) => r.product_id === productId);
    if (!tr || !row) return;
    const r = effective(row);
    const cells = tr.querySelectorAll('td');
    const offset = canApprove ? 1 : 0;
    cells[offset + 2].innerHTML = html`${money(r.cost_basis)}<div class="muted tiny">${COST_METHODS[r.cost_method]?.label.split(' (')[0] ?? ''}</div>`.toString();
    cells[offset + 3].textContent = money(r.landed_cost);
    if (edits[productId]?.price === undefined) { const input = tr.querySelector('[data-price]'); if (input) input.value = r.suggested_price ?? ''; }
    cells[offset + 8].innerHTML = (r.margin.amount != null ? html`${money(r.margin.amount)}<div class="muted tiny">${pct(r.margin.pct)} of price</div>` : html`—`).toString();
    cells[offset + 9].innerHTML = flagPills(r.flags).toString();
    tr.classList.toggle('edited', r.edited);
    const sel = tr.querySelector('[data-select]');
    if (sel) sel.checked = selected.has(productId);
    $('#publish', container)?.toggleAttribute('disabled', selected.size === 0);
  }

  on(container, 'click', '#publish', () => publishDialog());
  on(container, 'click', '[data-cancel-sched]', async (_e, el) => {
    try { await cancelScheduledPrice(Number(el.dataset.cancelSched)); toast('Scheduled change cancelled', 'success'); await load(); }
    catch (error) { reportError(error); }
  });
  on(container, 'click', '[data-open]', (_e, el) => productDrawer(rows.find((r) => r.product_id === el.dataset.open)));
  on(container, 'click', '#export', () => {
    downloadCsv(`price-board-${todayIso()}.csv`, visibleRows(), [
      { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'unit', label: 'Unit' }, { key: 'category_name', label: 'Category' },
      { key: 'supplier_quote', label: 'Quote' }, { key: 'cost_basis', label: 'Cost basis' }, { key: 'landed_cost', label: 'Landed cost' },
      { key: 'markup_pct', label: 'Markup %' }, { key: 'price', label: 'Suggested / typed' }, { key: 'current_price', label: 'Current price' },
      { key: 'benchmark_price', label: 'Benchmark' }, { key: 'benchmark_source_name', label: 'Benchmark source' }, { key: 'benchmark_date', label: 'Benchmark date' },
      { label: 'Margin', value: (r) => r.margin.amount }, { label: 'Margin %', value: (r) => r.margin.pct }, { label: 'Flags', value: (r) => r.flags.join(' ') },
    ]);
  });

  /** Confirm, optionally schedule, then publish the selected rows. */
  function publishDialog() {
    const chosen = rows.map(effective).filter((r) => selected.has(r.product_id));
    const guarded = chosen.filter((r) => r.flags.includes('below_cost') || r.flags.includes('below_min_markup'));
    const { el, close } = openModal(html`
      <form id="publish-form" class="stack" novalidate>
        <p>${chosen.length} product${chosen.length === 1 ? '' : 's'} will get the price shown in the Suggested column.</p>
        <div class="table-wrap"><table class="table small-table"><tbody>${chosen.map((r) => html`<tr><td>${r.name}</td><td class="right num">${money(r.current_price)} → <strong>${money(r.price)}</strong></td></tr>`)}</tbody></table></div>
        <label class="field"><span class="label">Reason (shown in the history)</span><input class="input" name="reason" maxlength="200" placeholder="Morning board"></label>
        <label class="field"><span class="label">Go live</span><select class="select" name="when"><option value="now">Now</option><option value="later">At a set time…</option></select></label>
        <label class="field" id="when-field" hidden><span class="label">Date and time</span><input class="input" type="datetime-local" name="effective_at"></label>
        ${guarded.length ? html`<div class="banner warn"><div><strong>${guarded.length} price${guarded.length === 1 ? ' is' : 's are'} below cost or under the minimum markup.</strong>
          <label class="check" style="margin-top:var(--space-2)"><input type="checkbox" name="force"> Publish anyway (refused where the category rule says "block")</label></div></div>` : ''}
        <p class="form-error" id="publish-error" role="alert"></p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Back</button><button class="btn primary" type="submit">Publish</button></div>
      </form>`, { title: 'Publish prices' });
    $('[name=when]', el).onchange = (e) => { $('#when-field', el).hidden = e.target.value !== 'later'; };
    $('#publish-form', el).onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target;
      const effectiveAt = form.elements.when.value === 'later' && form.elements.effective_at.value ? new Date(form.elements.effective_at.value).toISOString() : null;
      try {
        const result = await withBusy($('button[type="submit"]', form), () => applyPrices(
          chosen.map((r) => ({ product_id: r.product_id, price: r.price })),
          { reason: form.elements.reason.value, effectiveAt, force: form.elements.force?.checked ?? false },
        ));
        toast(result.scheduled ? `${result.scheduled} price change${result.scheduled === 1 ? '' : 's'} scheduled` : `${result.applied} price${result.applied === 1 ? '' : 's'} published`, 'success');
        close(); await load();
      } catch (error) { $('#publish-error', el).textContent = error.message; }
    };
  }

  /** The per-product drawer: explain, override, history. */
  async function productDrawer(row) {
    let overrides = [];
    let sources = [];
    let history = [];
    try { [overrides, sources, history] = await Promise.all([listProductPricing(), listBenchmarkSources(), listPriceHistory(row.product_id)]); }
    catch (error) { reportError(error); return; }
    const o = overrides.find((x) => x.product_id === row.product_id) ?? {};
    const r = effective(row);
    const series = [...history].reverse().map((h) => h.new_price);

    const { el, close } = openModal(html`
      <div class="stack">
        <div class="explain">
          <h3>How ${formatINR(r.suggested_price ?? 0)} is worked out</h3>
          <ol class="steps">
            <li>Cost basis (${COST_METHODS[r.cost_method]?.label ?? r.cost_method}): <strong>${money(r.cost_basis)}</strong>
              <span class="muted tiny">latest receipt ${money(r.latest_cost)}${r.latest_cost_date ? ` on ${formatDate(r.latest_cost_date)}` : ''} · 30-day average ${money(r.avg_cost_30d)} · quote ${money(r.supplier_quote)}</span></li>
            <li>+ transport ${money(r.transport_per_kg)}/kg and handling ${money(r.handling_per_kg)}/kg × ${r.weight_kg ?? 0} kg, + packing ${money(r.packing_per_unit)}/unit</li>
            <li>× market fee ${pct(r.market_fee_pct)} × other costs ${pct(r.other_cost_pct)} ÷ yield ${pct(r.yield_pct)} ÷ (1 − wastage ${pct(r.wastage_pct)}) = landed <strong>${money(r.landed_cost)}</strong></li>
            <li>${r.pricing_mode === 'rule' ? html`× markup ${pct(r.markup_pct)}` : r.pricing_mode === 'fixed_over_benchmark' ? html`benchmark ${money(r.benchmark_price)} + ${money(r.fixed_margin_amount)}` : html`manual price ${money(r.manual_price)}`} = ${money(r.raw_price)}</li>
            <li>${r.benchmark_cap_pct != null && r.benchmark_price != null ? html`cap: benchmark ${money(r.benchmark_price)} × ${(1 + Number(r.benchmark_cap_pct) / 100).toFixed(2)} = ${money(Number(r.benchmark_price) * (1 + Number(r.benchmark_cap_pct) / 100))}${r.capped ? ' → applied' : ' (not reached)'} · ` : ''}rounded to ₹${r.rounding_step} (${r.round_mode}) = <strong>${money(r.suggested_price)}</strong>; margin ${money(r.margin_amount)} (${pct(r.margin_pct)} of price, ${pct(r.markup_effective_pct)} on cost)</li>
          </ol>
          ${flagPills(r.flags)}
        </div>
        ${series.length > 1 ? html`<div><span class="label">Published price, last ${series.length} changes</span>
          <svg class="spark" viewBox="0 0 240 40" width="240" height="40" aria-label="Price history"><path d="${sparklinePath(series, 240, 40)}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>` : ''}
        ${history.length ? html`<div class="table-wrap"><table class="table small-table"><thead><tr><th>When</th><th class="right">Old</th><th class="right">New</th><th class="right">Cost</th><th>Reason</th></tr></thead>
          <tbody>${history.slice(0, 8).map((h) => html`<tr><td class="muted">${formatDate(h.created_at)}</td><td class="right num">${money(h.old_price)}</td><td class="right num">${money(h.new_price)}</td><td class="right num">${money(h.cost_used)}</td><td>${h.reason ?? ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">No published changes yet.</p>`}
        ${canEdit ? html`<form id="override-form" class="stack" novalidate>
          <h3>Override for this product <span class="muted small">(blank = use the ${r.category_name ?? 'category'} rule)</span></h3>
          <div class="form-grid">
            <label class="field"><span class="label">How to price</span><select class="select" name="pricing_mode">
              ${Object.entries(PRICING_MODES).map(([k, v]) => html`<option value="${k}" ${(o.pricing_mode ?? 'rule') === k ? 'selected' : ''}>${v.label}</option>`)}</select></label>
            <label class="field"><span class="label">Cost from</span><select class="select" name="cost_method"><option value="">Category rule (${COST_METHODS[r.cost_method]?.label ?? ''})</option>
              ${Object.entries(COST_METHODS).map(([k, v]) => html`<option value="${k}" ${o.cost_method === k ? 'selected' : ''}>${v.label}</option>`)}</select></label>
            <label class="field"><span class="label">Typed cost (₹)</span><input class="input" name="manual_cost" type="number" min="0" step="0.01" value="${o.manual_cost ?? ''}"></label>
            <label class="field"><span class="label">Supplier quote (₹)</span><input class="input" name="supplier_quote" type="number" min="0" step="0.01" value="${o.supplier_quote ?? ''}"></label>
            <label class="field"><span class="label">Markup %</span><input class="input" name="markup_pct" type="number" min="0" step="0.1" value="${o.markup_pct ?? ''}" placeholder="${r.markup_pct}"></label>
            <label class="field"><span class="label">Minimum markup %</span><input class="input" name="min_markup_pct" type="number" min="0" step="0.1" value="${o.min_markup_pct ?? ''}" placeholder="${r.min_markup_pct}"></label>
            <label class="field"><span class="label">Wastage %</span><input class="input" name="wastage_pct" type="number" min="0" max="99" step="0.1" value="${o.wastage_pct ?? ''}" placeholder="${r.wastage_pct}"></label>
            <label class="field"><span class="label">Yield % (after dressing / cleaning)</span><input class="input" name="yield_pct" type="number" min="1" max="100" step="0.1" value="${o.yield_pct ?? 100}"></label>
            <label class="field"><span class="label">Transport ₹/kg</span><input class="input" name="transport_per_kg" type="number" min="0" step="0.01" value="${o.transport_per_kg ?? ''}" placeholder="${r.transport_per_kg}"></label>
            <label class="field"><span class="label">Handling ₹/kg</span><input class="input" name="handling_per_kg" type="number" min="0" step="0.01" value="${o.handling_per_kg ?? ''}" placeholder="${r.handling_per_kg}"></label>
            <label class="field"><span class="label">Packing ₹/unit</span><input class="input" name="packing_per_unit" type="number" min="0" step="0.01" value="${o.packing_per_unit ?? ''}" placeholder="${r.packing_per_unit}"></label>
            <label class="field"><span class="label">Market fee %</span><input class="input" name="market_fee_pct" type="number" min="0" step="0.1" value="${o.market_fee_pct ?? ''}" placeholder="${r.market_fee_pct}"></label>
            <label class="field"><span class="label">Other costs %</span><input class="input" name="other_cost_pct" type="number" min="0" step="0.1" value="${o.other_cost_pct ?? ''}" placeholder="${r.other_cost_pct}"></label>
            <label class="field"><span class="label">Rounding step (₹)</span><input class="input" name="rounding_step" type="number" min="0.01" step="0.01" value="${o.rounding_step ?? ''}" placeholder="${r.rounding_step}"></label>
            <label class="field"><span class="label">Round</span><select class="select" name="round_mode"><option value="">Rule (${r.round_mode})</option><option value="nearest" ${o.round_mode === 'nearest' ? 'selected' : ''}>Nearest</option><option value="up" ${o.round_mode === 'up' ? 'selected' : ''}>Up</option></select></label>
            <label class="field"><span class="label">Benchmark cap % above</span><input class="input" name="benchmark_cap_pct" type="number" min="0" step="0.1" value="${o.benchmark_cap_pct ?? ''}" placeholder="${r.benchmark_cap_pct ?? 'none'}"></label>
            <label class="field"><span class="label">Benchmark source</span><select class="select" name="benchmark_source_id"><option value="">Rule / newest</option>
              ${sources.map((s) => html`<option value="${s.id}" ${o.benchmark_source_id === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></label>
            <label class="field"><span class="label">Fixed amount over benchmark (₹)</span><input class="input" name="fixed_margin_amount" type="number" step="0.01" value="${o.fixed_margin_amount ?? ''}"><span class="hint">e.g. eggs: NECC + ₹9 per tray</span></label>
            <label class="field"><span class="label">Manual price (₹)</span><input class="input" name="manual_price" type="number" min="0" step="0.01" value="${o.manual_price ?? ''}"></label>
            <label class="field span-2"><span class="label">Reason / note</span><input class="input" name="manual_reason" maxlength="200" value="${o.manual_reason ?? ''}"></label>
          </div>
          <p class="muted tiny">Selling unit: ${r.unit} = ${Number(row.pack_size ?? 1)} ${PACK_UNITS[row.pack_unit] ?? ''} — change under Products.</p>
          <p class="form-error" id="override-error" role="alert"></p>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Close</button><button class="btn primary" type="submit">Save override</button></div>
        </form>` : html`<div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Close</button></div>`}
      </div>`, { title: `${row.name} · ${row.sku}`, wide: true });

    const form = $('#override-form', el);
    if (form) {
      form.onsubmit = async (event) => {
        event.preventDefault();
        const v = Object.fromEntries(new FormData(form));
        try {
          await withBusy($('button[type="submit"]', form), () => saveProductPricing(row.product_id, { ...v, quote_date: v.supplier_quote ? (o.quote_date ?? todayIso()) : null }));
          toast('Override saved', 'success');
          close(); await load();
        } catch (error) { $('#override-error', el).textContent = error.message; }
      };
    }
  }

  await load();
}
