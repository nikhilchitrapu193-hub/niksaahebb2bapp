// =============================================================================
// launch.js — Settings → Launch: the "lite mode" switches (migration 014).
//
//   1. Live sectors — one switch per customer type (sectors.is_active). Off =
//      the sector cannot sign up or order; its customers see "not taking orders
//      yet". Start with army cantonments, switch restaurants on later.
//   2. Pricing mode — simple (type a price on the product form) or advanced
//      (the pricing engine). Hides / shows the Pricing menu.
//   3. Stock mode — simple (in stock / out of stock only) or counted (the
//      ledger). Hides / shows Inventory and Procurement.
// The screen also shows, per sector, how many customers have signed up and how
// many orders came in, so the admin can see when a sector is ready to open.
// Changing a mode reloads the page so the menu reflects it.
// =============================================================================

import { html, mount, on, $, reportError, toast, withBusy, confirmDialog } from '../../core/ui.js';
import { getLaunchStatus, setSectorLive, saveLaunchModes } from '../../core/api.js';
import { can } from '../../core/permissions.js';
import { LAUNCH_PRICING_MODES, STOCK_MODES, MODULES } from '../../core/config.js';
import { hiddenModules } from '../../core/launch.js';
import { settingsTabs } from './settings.js';

export async function renderLaunch(container, me) {
  const editable = can(me, 'settings', 'edit');
  let status = await getLaunchStatus();

  async function reload() { status = await getLaunchStatus(); draw(); }

  function draw() {
    const live = status.sectors.filter((s) => s.is_active);
    const hidden = hiddenModules(status);
    const hiddenLabels = [...hidden].map((m) => MODULES[m]?.label ?? m);
    mount(container, html`
      <div class="page-head"><div><h1>Launch</h1><p>Decide who can order and how much of the app your team sees. Nothing is deleted when a switch is off.</p></div></div>
      ${settingsTabs(me, '#launch')}

      <section class="card" style="margin-bottom:var(--space-5)">
        <div class="card-head"><h2>Live sectors</h2><span class="muted small">${live.length} of ${status.sectors.length} on</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Sector</th><th class="right">Customers</th><th class="right">Approved</th><th class="right">Orders, 30 days</th><th>Status</th><th></th></tr></thead>
          <tbody>${status.sectors.map((s) => html`<tr data-sector="${s.code}">
            <td><strong>${s.name}</strong><div class="muted tiny">${s.description}${s.can_self_register ? '' : ' · sign-up by invitation only'}</div></td>
            <td class="right num">${s.customers}${Number(s.customers_pending) > 0 ? html`<div class="muted tiny">${s.customers_pending} waiting</div>` : ''}</td>
            <td class="right num">${s.customers_approved}</td>
            <td class="right num">${s.orders_30d}</td>
            <td><span class="badge ${s.is_active ? 'approved' : 'inactive'}">${s.is_active ? 'Live' : 'Not yet'}</span></td>
            <td class="right">${editable ? html`<label class="switch"><input type="checkbox" data-live="${s.code}" ${s.is_active ? 'checked' : ''} aria-label="${s.name} live"><span class="slider"></span></label>` : ''}</td>
          </tr>`)}</tbody></table></div>
        <p class="muted small" style="padding:0 var(--space-4) var(--space-4)">A sector that is off cannot sign up or place orders; existing customers in it see "we are not taking orders from your sector yet". Terms per sector are under <a href="#sectors">Sectors &amp; terms</a>.</p>
      </section>

      <form id="modes" class="form-grid" style="align-items:start">
        <section class="card card-pad stack">
          <h2>Pricing</h2>
          ${Object.entries(LAUNCH_PRICING_MODES).map(([k, v]) => html`<label class="check" style="align-items:flex-start">
            <input type="radio" name="pricing_mode" value="${k}" ${status.pricing_mode === k ? 'checked' : ''} ${editable ? '' : 'disabled'}>
            <span><strong>${v.label}</strong><br><span class="muted small">${v.hint}</span></span></label>`)}
        </section>
        <section class="card card-pad stack">
          <h2>Stock</h2>
          ${Object.entries(STOCK_MODES).map(([k, v]) => html`<label class="check" style="align-items:flex-start">
            <input type="radio" name="stock_mode" value="${k}" ${status.stock_mode === k ? 'checked' : ''} ${editable ? '' : 'disabled'}>
            <span><strong>${v.label}</strong><br><span class="muted small">${v.hint}</span></span></label>`)}
        </section>
        <div class="span-2 row" style="justify-content:space-between;align-items:center">
          <span class="muted small">${hiddenLabels.length ? html`Hidden from the admin menu right now: <strong>${hiddenLabels.join(', ')}</strong>.` : 'Every module is showing (the full app).'}
            ${status.products_listed} product${Number(status.products_listed) === 1 ? '' : 's'} listed, ${status.products_in_stock} in stock.</span>
          ${editable ? html`<button class="btn primary" type="submit">Save modes</button>` : ''}
        </div>
      </form>
      ${editable ? '' : html`<p class="muted small" style="margin-top:var(--space-3)">You can view these switches but not change them (needs settings: edit).</p>`}`);
  }

  on(container, 'change', '[data-live]', async (_e, box) => {
    const sector = status.sectors.find((s) => s.code === box.dataset.live);
    if (!box.checked && !(await confirmDialog(`Switch ${sector.name} off? Its customers cannot order until it is on again.`, { confirmText: 'Switch off', danger: true }))) {
      box.checked = true; return;
    }
    try {
      await setSectorLive(box.dataset.live, box.checked);
      toast(`${sector.name}: ${box.checked ? 'live' : 'off'}`, 'success');
      await reload();
    } catch (error) { reportError(error); box.checked = !box.checked; }
  });

  on(container, 'submit', '#modes', async (event, form) => {
    event.preventDefault();
    const pricingMode = form.elements.pricing_mode.value;
    const stockMode = form.elements.stock_mode.value;
    try {
      await withBusy($('button[type="submit"]', form), () => saveLaunchModes({ pricingMode, stockMode }));
      toast('Modes saved — reloading the menu', 'success');
      // The menu is built once at start-up from these modes; a reload applies them everywhere.
      setTimeout(() => location.reload?.(), 600);
    } catch (error) { reportError(error); }
  });

  draw();
}
