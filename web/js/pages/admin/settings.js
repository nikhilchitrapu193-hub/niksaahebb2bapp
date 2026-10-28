// =============================================================================
// settings.js — company details printed on every invoice, plus the tab strip
// that leads to the other settings screens (launch, locations, sectors, slots,
// notifications, help centre, roles).
// =============================================================================

import { html, mount, on, $, withBusy, toast, reportError } from '../../core/ui.js';
import { getCompanySettings, saveCompanySettings } from '../../core/api.js';
import { can } from '../../core/permissions.js';

/** Shared tab strip for every settings screen. `active` is the route, e.g. '#locations'. */
export function settingsTabs(me, active) {
  const tabs = [
    { href: '#settings', label: 'Company', show: true },
    { href: '#launch', label: 'Launch', show: true },
    { href: '#locations', label: 'Cities & warehouses', show: true },
    { href: '#sectors', label: 'Sectors & terms', show: true },
    { href: '#slots', label: 'Delivery slots', show: true },
    { href: '#notifications', label: 'Notifications', show: true },
    { href: '#help-centre', label: 'Help centre', show: true },
    { href: '#website', label: 'Website', show: true },
    { href: '#roles', label: 'Roles & permissions', show: can(me, 'team', 'view') },
  ];
  return html`<div class="tabs" role="tablist">
    ${tabs.filter((t) => t.show).map((t) => html`<a role="tab" href="${t.href}" aria-selected="${String(t.href === active)}">${t.label}</a>`)}
  </div>`;
}

export async function renderSettings(container, me) {
  const s = await getCompanySettings();
  const readOnly = !can(me, 'settings', 'edit');
  mount(container, html`
    <div class="page-head"><div><h1>Settings</h1><p>Company details shown on invoices and used as the seller's details.</p></div></div>
    ${settingsTabs(me, '#settings')}
    <form class="card card-pad stack" id="settings-form" novalidate>
      <div class="form-grid">
        <label class="field span-2"><span class="label">Legal / trading name</span><input class="input" name="name" value="${s.name}" required maxlength="160" ${readOnly ? 'disabled' : ''}></label>
        <label class="field span-2"><span class="label">Address</span><textarea class="textarea" name="address" rows="2" maxlength="400" ${readOnly ? 'disabled' : ''}>${s.address}</textarea></label>
        <label class="field"><span class="label">Phone</span><input class="input" name="phone" value="${s.phone}" maxlength="20" ${readOnly ? 'disabled' : ''}></label>
        <label class="field"><span class="label">Email</span><input class="input" name="email" type="email" value="${s.email}" maxlength="120" ${readOnly ? 'disabled' : ''}></label>
        <label class="field"><span class="label">GSTIN</span><input class="input" name="gstin" value="${s.gstin}" maxlength="15" ${readOnly ? 'disabled' : ''}></label>
        <label class="field"><span class="label">FSSAI licence no.</span><input class="input" name="fssai" value="${s.fssai}" maxlength="20" ${readOnly ? 'disabled' : ''}></label>
        <label class="field span-2"><span class="label">Invoice footer note</span><input class="input" name="invoice_note" value="${s.invoice_note}" maxlength="300" ${readOnly ? 'disabled' : ''}></label>
        <label class="check span-2"><input type="checkbox" name="show_prices_incl_gst" ${s.show_prices_incl_gst ? 'checked' : ''} ${readOnly ? 'disabled' : ''}> Show catalogue prices including GST <span class="muted small">(invoices always show the split)</span></label>
      </div>
      ${readOnly ? html`<p class="muted small">You can view these settings but not change them (needs settings: edit).</p>`
                 : html`<div><button class="btn primary" type="submit">Save settings</button></div>`}
    </form>`);

  on(container, 'submit', '#settings-form', async (event, form) => {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    v.show_prices_incl_gst = form.elements.show_prices_incl_gst.checked;
    try {
      await withBusy($('button[type="submit"]', form), () => saveCompanySettings(v));
      toast('Settings saved', 'success');
    } catch (error) { reportError(error); }
  });
}
