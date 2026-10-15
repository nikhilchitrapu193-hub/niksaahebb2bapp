// =============================================================================
// pricing-rules.js — Pricing → Rules: the pricing variables per category.
//
// One card per category (plus "Global default") shows the rule in force
// today; a sub-category without its own rule uses its parent's, then the global one. Editing creates a NEW row effective from a chosen date and closes
// the old one the day before, so old values stay on record and a change can
// be prepared ahead ("from 1 November, vegetables markup 14%"). A "Test"
// box shows what a sample cost would sell for under the row's numbers, using
// the same formula as the board (web/js/core/pricing.js).
// =============================================================================

import { html, mount, on, $, formatINR, formatDate, openModal, reportError, toast, withBusy } from '../../core/ui.js';
import { listPricingRules, savePricingRule, listCategories, listBenchmarkSources } from '../../core/api.js';
import { computePrice } from '../../core/pricing.js';
import { COST_METHODS } from '../../core/config.js';
import { can } from '../../core/permissions.js';
import { pricingTabs, todayIso } from './price-board.js';
import { categoryOptions } from '../../core/catalogue.js';

/** The rule in force on `day` for a category (null = global): newest effective_from that has started and not ended. */
export function ruleInForce(rules, categoryId, day) {
  return rules
    .filter((r) => (r.category_id ?? null) === (categoryId ?? null) && r.effective_from <= day && (!r.effective_to || r.effective_to >= day))
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null;
}

export async function renderPricingRules(container, me) {
  const editable = can(me, 'pricing', 'edit');
  const today = todayIso();
  let [rules, categories, sources] = await Promise.all([listPricingRules(), listCategories(), listBenchmarkSources()]);

  async function reload() { rules = await listPricingRules(); draw(); }

  function draw() {
    const global = ruleInForce(rules, null, today);
    const cards = [{ id: null, name: 'Global default', path: 'Global default', depth: 0 }, ...categoryOptions(categories)].map((c) => {
      const own = ruleInForce(rules, c.id, today);
      const parentRule = c.parent_id ? ruleInForce(rules, c.parent_id, today) : null;
      const upcoming = rules.filter((r) => (r.category_id ?? null) === (c.id ?? null) && r.effective_from > today).sort((a, b) => (a.effective_from > b.effective_from ? 1 : -1))[0];
      const inheritedFrom = own ? null : parentRule ? categories.find((x) => x.id === c.parent_id)?.name : c.id != null ? 'the global default' : null;
      return { category: c, rule: own, inheritedFrom, shown: own ?? parentRule ?? global, upcoming };
    });
    mount(container, html`
      <div class="page-head"><div><h1>Pricing rules</h1><p>The variables behind every price, per category. Products can override any of them on the price board.</p></div></div>
      ${pricingTabs('#pricing-rules')}
      ${!global ? html`<div class="banner error">There is no global rule in force today. Add one so products without a category rule can be priced.</div>` : ''}
      <div class="rule-grid">${cards.map(({ category, rule, inheritedFrom, shown, upcoming }) => html`
        <div class="card card-pad rule-card ${category.depth ? 'sub' : ''}">
          <div class="spread"><h3>${category.path ?? category.name}</h3>
            ${editable ? html`<button class="btn small" data-edit="${category.id ?? ''}">${rule ? 'Change' : 'Set own rule'}</button>` : ''}</div>
          ${inheritedFrom ? html`<p class="muted tiny">Uses ${inheritedFrom === 'the global default' ? inheritedFrom : `the ${inheritedFrom} rule`}.</p>` : ''}
          ${shown ? html`
            <dl class="kv compact">
              <dt>Markup</dt><dd>${Number(shown.markup_pct)}% <span class="muted">(min ${Number(shown.min_markup_pct)}%)</span></dd>
              <dt>Wastage</dt><dd>${Number(shown.wastage_pct)}%</dd>
              <dt>Per kg</dt><dd>transport ${formatINR(shown.transport_per_kg)} · handling ${formatINR(shown.handling_per_kg)}</dd>
              <dt>Per unit</dt><dd>packing ${formatINR(shown.packing_per_unit)}</dd>
              <dt>Fees</dt><dd>market ${Number(shown.market_fee_pct)}% · other ${Number(shown.other_cost_pct)}%</dd>
              <dt>Rounding</dt><dd>₹${Number(shown.rounding_step)} ${shown.round_mode}</dd>
              <dt>Benchmark cap</dt><dd>${shown.benchmark_cap_pct == null ? 'none' : `${Number(shown.benchmark_cap_pct)}% above`}${shown.benchmark_source_id ? html` · ${sources.find((s) => s.id === shown.benchmark_source_id)?.name ?? ''}` : ''}</dd>
              <dt>Cost from</dt><dd>${COST_METHODS[shown.cost_method]?.label ?? shown.cost_method}</dd>
              <dt>Margin guard</dt><dd>${shown.guard_mode === 'block' ? 'Block below cost / minimum' : 'Warn and ask to confirm'}</dd>
              <dt>In force</dt><dd>from ${formatDate(shown.effective_from)}${shown.effective_to ? ` to ${formatDate(shown.effective_to)}` : ''}</dd>
            </dl>
            ${shown.note ? html`<p class="muted tiny">${shown.note}</p>` : ''}` : html`<p class="muted">No rule.</p>`}
          ${upcoming ? html`<div class="banner info" style="margin:var(--space-3) 0 0"><span>From ${formatDate(upcoming.effective_from)}: markup ${Number(upcoming.markup_pct)}%, wastage ${Number(upcoming.wastage_pct)}%.</span></div>` : ''}
        </div>`)}</div>`);
  }

  on(container, 'click', '[data-edit]', (_e, el) => {
    const categoryId = el.dataset.edit || null;
    const parentId = categories.find((c) => c.id === categoryId)?.parent_id ?? null;
    const current = ruleInForce(rules, categoryId, today) ?? (parentId && ruleInForce(rules, parentId, today)) ?? ruleInForce(rules, null, today) ?? {};
    ruleForm(categoryId, current, { categories, sources, rules, onSaved: reload });
  });

  draw();
}

/**
 * Edit dialog. Saves a NEW row effective from the chosen date; a row already
 * covering that date is closed the day before so the dates never overlap.
 */
function ruleForm(categoryId, base, { categories, sources, rules, onSaved }) {
  const name = categoryId ? categoryOptions(categories).find((c) => c.id === categoryId)?.path : 'Global default';
  const today = todayIso();
  const { el, close } = openModal(html`
    <form id="rule-form" class="stack" novalidate>
      <div class="form-grid">
        <label class="field"><span class="label">Markup %</span><input class="input" name="markup_pct" type="number" min="0" step="0.1" value="${base.markup_pct ?? 10}" required></label>
        <label class="field"><span class="label">Minimum markup % (margin guard)</span><input class="input" name="min_markup_pct" type="number" min="0" step="0.1" value="${base.min_markup_pct ?? 0}" required></label>
        <label class="field"><span class="label">Wastage %</span><input class="input" name="wastage_pct" type="number" min="0" max="99" step="0.1" value="${base.wastage_pct ?? 0}" required><span class="hint">Share bought that is never sold (spoilage, trimming)</span></label>
        <label class="field"><span class="label">Margin guard</span><select class="select" name="guard_mode"><option value="warn" ${base.guard_mode !== 'block' ? 'selected' : ''}>Warn and ask to confirm</option><option value="block" ${base.guard_mode === 'block' ? 'selected' : ''}>Block below cost / minimum</option></select></label>
        <label class="field"><span class="label">Transport ₹ per kg</span><input class="input" name="transport_per_kg" type="number" min="0" step="0.01" value="${base.transport_per_kg ?? 0}"></label>
        <label class="field"><span class="label">Handling ₹ per kg</span><input class="input" name="handling_per_kg" type="number" min="0" step="0.01" value="${base.handling_per_kg ?? 0}"></label>
        <label class="field"><span class="label">Packing ₹ per unit</span><input class="input" name="packing_per_unit" type="number" min="0" step="0.01" value="${base.packing_per_unit ?? 0}"></label>
        <label class="field"><span class="label">Market fee %</span><input class="input" name="market_fee_pct" type="number" min="0" step="0.1" value="${base.market_fee_pct ?? 0}"><span class="hint">Mandi commission, loading</span></label>
        <label class="field"><span class="label">Other costs %</span><input class="input" name="other_cost_pct" type="number" min="0" step="0.1" value="${base.other_cost_pct ?? 0}"></label>
        <label class="field"><span class="label">Cost from</span><select class="select" name="cost_method">
          ${Object.entries(COST_METHODS).map(([k, v]) => html`<option value="${k}" ${(base.cost_method ?? 'weighted_avg_30d') === k ? 'selected' : ''}>${v.label}</option>`)}</select></label>
        <label class="field"><span class="label">Rounding step (₹)</span><select class="select" name="rounding_step">
          ${[0.1, 0.5, 1, 5, 10].map((s) => html`<option value="${s}" ${Number(base.rounding_step ?? 1) === s ? 'selected' : ''}>₹${s}</option>`)}</select></label>
        <label class="field"><span class="label">Round</span><select class="select" name="round_mode"><option value="nearest" ${base.round_mode !== 'up' ? 'selected' : ''}>Nearest</option><option value="up" ${base.round_mode === 'up' ? 'selected' : ''}>Always up</option></select></label>
        <label class="field"><span class="label">Benchmark cap: at most % above</span><input class="input" name="benchmark_cap_pct" type="number" min="0" step="0.1" value="${base.benchmark_cap_pct ?? ''}" placeholder="no cap"></label>
        <label class="field"><span class="label">Benchmark source</span><select class="select" name="benchmark_source_id"><option value="">Newest of any source</option>
          ${sources.map((s) => html`<option value="${s.id}" ${base.benchmark_source_id === s.id ? 'selected' : ''}>${s.name}</option>`)}</select></label>
        <label class="field"><span class="label">In force from</span><input class="input" name="effective_from" type="date" value="${today}" required></label>
        <label class="field span-2"><span class="label">Note</span><input class="input" name="note" maxlength="200" value="${base.note ?? ''}"></label>
      </div>
      <div class="card card-pad" style="background:var(--surface-sunk)">
        <div class="row"><label class="field"><span class="label">Test: a cost of ₹</span><input class="input" id="test-cost" type="number" min="0" step="0.01" value="100" style="width:120px"></label>
          <div id="test-result" class="muted small" style="align-self:flex-end;padding-bottom:var(--space-2)"></div></div>
      </div>
      <p class="form-error" id="rule-error" role="alert"></p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save rule</button></div>
    </form>`, { title: `${name} — pricing rule`, wide: true });

  const form = $('#rule-form', el);
  function runTest() {
    const v = Object.fromEntries(new FormData(form));
    const r = computePrice({ pricing_mode: 'rule', weight_kg: 1, ...v, cost_method: 'manual', manual_cost: $('#test-cost', el).value });
    $('#test-result', el).textContent = r.suggested_price == null ? '' : `1 kg bought at ${formatINR(r.cost_basis)} → landed ${formatINR(r.landed_cost)} → sells at ${formatINR(r.suggested_price)} (margin ${formatINR(r.margin_amount)}, ${r.margin_pct}% of price)`;
  }
  form.addEventListener('input', runTest);
  runTest();

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!form.checkValidity()) { $('#rule-error', el).textContent = 'Please fill in every number.'; return; }
    const v = Object.fromEntries(new FormData(form));
    try {
      await withBusy($('button[type="submit"]', form), async () => {
        // Close the row that would otherwise overlap: it ends the day before the new one starts.
        const overlapping = rules.filter((r) => (r.category_id ?? null) === categoryId && r.effective_from < v.effective_from && (!r.effective_to || r.effective_to >= v.effective_from));
        for (const r of overlapping) {
          const dayBefore = new Date(`${v.effective_from}T00:00:00Z`); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
          await savePricingRule({ ...r, effective_to: dayBefore.toISOString().slice(0, 10) });
        }
        const sameDay = rules.find((r) => (r.category_id ?? null) === categoryId && r.effective_from === v.effective_from);
        await savePricingRule({ ...v, id: sameDay?.id, category_id: categoryId });
      });
      toast('Rule saved', 'success');
      close(); onSaved();
    } catch (error) { $('#rule-error', el).textContent = error.message; }
  };
}
