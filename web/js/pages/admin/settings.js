// =============================================================================
// settings.js — company details printed on every invoice.
// =============================================================================

import { html, mount, on, $, withBusy, toast, reportError } from '../../core/ui.js';
import { getCompanySettings, saveCompanySettings } from '../../core/api.js';

export async function renderSettings(container) {
  const s = await getCompanySettings();
  mount(container, html`
    <div class="page-head"><div><h1>Company settings</h1><p>Shown on invoices and used as the seller's details.</p></div></div>
    <form class="card card-pad stack" id="settings-form" novalidate>
      <div class="form-grid">
        <label class="field span-2"><span class="label">Legal / trading name</span><input class="input" name="name" value="${s.name}" required maxlength="160"></label>
        <label class="field span-2"><span class="label">Address</span><textarea class="textarea" name="address" rows="2" maxlength="400">${s.address}</textarea></label>
        <label class="field"><span class="label">Phone</span><input class="input" name="phone" value="${s.phone}" maxlength="20"></label>
        <label class="field"><span class="label">Email</span><input class="input" name="email" type="email" value="${s.email}" maxlength="120"></label>
        <label class="field"><span class="label">GSTIN</span><input class="input" name="gstin" value="${s.gstin}" maxlength="15"></label>
        <label class="field"><span class="label">FSSAI licence no.</span><input class="input" name="fssai" value="${s.fssai}" maxlength="20"></label>
        <label class="field span-2"><span class="label">Invoice footer note</span><input class="input" name="invoice_note" value="${s.invoice_note}" maxlength="300"></label>
      </div>
      <div><button class="btn primary" type="submit">Save settings</button></div>
    </form>`);

  on(container, 'submit', '#settings-form', async (event, form) => {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try {
      await withBusy($('button[type="submit"]', form), () => saveCompanySettings(v));
      toast('Settings saved', 'success');
    } catch (error) { reportError(error); }
  });
}
