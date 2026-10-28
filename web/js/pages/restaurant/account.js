// =============================================================================
// account.js — edit contact details, business info and delivery area (city +
// pin code). Changing the pin code re-assigns the serving warehouse; if no
// warehouse serves it, ordering pauses until we add the area.
// Map pin (migration 018): "Use my location" stores lat/lng so the driver's
// map opens on the exact gate, not a search for the address.
// Documents (migration 019): FSSAI licence / GST certificate uploads to a
// private bucket; staff see them before approving the account.
// =============================================================================

import { html, mount, on, $, withBusy, toast, reportError, statusBadge } from '../../core/ui.js';
import { updateMyProfile, updateMyRestaurant, updateMyDeliveryArea, listCities, getMyOrderTerms, updateMyLocation, uploadCustomerDocument, customerDocumentUrl } from '../../core/api.js';
import { CUSTOMER_DOCUMENTS, CUSTOMER_ROLES } from '../../core/config.js';
import { renderOrganisation } from './organisation.js';
import { mapHref } from '../../core/notify.js';
import { currentPosition } from '../../core/geo.js';

export async function renderAccount(container, state) {
  const { profile, restaurant, user } = state.me;
  const cities = await listCities().catch(() => []);
  // Members (migration 020): only the owner edits the business details and delivery area.
  const role = state.terms?.customer_role ?? 'owner';
  const isOwner = role === 'owner';
  const ro = isOwner ? '' : 'disabled';
  mount(container, html`
    <div class="page-head"><div><h1>Account</h1><p>${user.email}${role !== 'owner' ? html` · ${CUSTOMER_ROLES[role]?.label ?? role}` : ''}</p></div>${restaurant ? statusBadge(restaurant.status) : ''}</div>
    <div id="organisation"></div>
    <form class="card card-pad stack" id="account-form" style="margin-top:var(--space-4)">
      <h2>Business details</h2>
      ${isOwner ? '' : html`<p class="muted small">Only the account owner can change these.</p>`}
      <div class="form-grid">
        <label class="field"><span class="label">Restaurant name</span><input class="input" name="name" value="${restaurant?.name ?? ''}" required maxlength="120" ${ro}></label>
        <label class="field"><span class="label">Restaurant phone</span><input class="input" name="rphone" value="${restaurant?.phone ?? ''}" maxlength="20" ${ro}></label>
        <label class="field span-2"><span class="label">Delivery address</span><textarea class="textarea" name="address" rows="2" maxlength="300" ${ro}>${restaurant?.address ?? ''}</textarea></label>
        <label class="field"><span class="label">City</span><select class="select" name="cityId" ${ro}>
          ${cities.map((c) => html`<option value="${c.id}" ${c.id === restaurant?.city_id ? 'selected' : ''}>${c.name}</option>`)}</select></label>
        <label class="field"><span class="label">Pin code</span><input class="input" name="pincode" value="${restaurant?.pincode ?? ''}" pattern="[1-9][0-9]{5}" maxlength="6" inputmode="numeric" ${ro}>
          <span class="hint">${state.terms?.delivers === false ? 'We do not deliver here yet.' : 'Decides which warehouse serves you.'}</span></label>
        <div class="field span-2" id="pin-field"><span class="label">Map pin for the driver</span>
          <div class="row-wrap">
            <button class="btn" type="button" id="use-location">📍 Use my location</button>
            ${restaurant?.lat != null ? html`<a class="btn ghost" href="${mapHref(restaurant.lat, restaurant.lng)}" target="_blank" rel="noopener">View pin</a><button class="btn ghost" type="button" id="clear-location">Remove pin</button>` : ''}
            <span class="hint" id="pin-status">${restaurant?.lat != null ? `Pinned at ${Number(restaurant.lat).toFixed(5)}, ${Number(restaurant.lng).toFixed(5)}` : 'Not set — stand at your delivery gate and tap the button.'}</span>
          </div></div>
        <label class="field"><span class="label">FSSAI licence no.</span><input class="input" name="fssai" value="${restaurant?.fssai ?? ''}" maxlength="20" ${ro}></label>
        <label class="field"><span class="label">GSTIN (optional)</span><input class="input" name="gstin" value="${restaurant?.gstin ?? ''}" maxlength="15" ${ro}></label>
      </div>
      <h2>Documents</h2>
      <p class="muted small">${restaurant?.status === 'pending' ? 'Upload your FSSAI licence so we can approve your account faster.' : 'Kept on file for approval and GST invoicing.'} PDF or photo, up to 8 MB.</p>
      <div class="form-grid" id="documents">
        ${Object.entries(CUSTOMER_DOCUMENTS).map(([kind, d]) => html`<div class="field"><span class="label">${d.label}</span>
          <div class="row-wrap">
            ${restaurant?.[d.column] ? html`<a class="btn ghost small" href="#" data-view-doc="${kind}">View</a><span class="badge delivered">on file</span>` : html`<span class="muted small">${d.hint}</span>`}
            <label class="btn small" style="cursor:pointer">${restaurant?.[d.column] ? 'Replace' : 'Upload'}<input type="file" hidden data-upload-doc="${kind}" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
          </div></div>`)}
      </div>
      <h2>Your contact</h2>
      <div class="form-grid">
        <label class="field"><span class="label">Your name</span><input class="input" name="fullName" value="${profile.full_name ?? ''}" maxlength="120"></label>
        <label class="field"><span class="label">Your phone</span><input class="input" name="phone" value="${profile.phone ?? ''}" maxlength="20"></label>
      </div>
      <div><button class="btn primary" type="submit">Save changes</button></div>
    </form>`);
  renderOrganisation($('#organisation', container), state).catch(reportError);

  on(container, 'change', '[data-upload-doc]', async (_e, input) => {
    const file = input.files?.[0];
    if (!file || !restaurant) return;
    try {
      const path = await uploadCustomerDocument(restaurant.id, input.dataset.uploadDoc, file);
      restaurant[CUSTOMER_DOCUMENTS[input.dataset.uploadDoc].column] = path;
      toast(`${CUSTOMER_DOCUMENTS[input.dataset.uploadDoc].label} uploaded`, 'success');
      renderAccount(container, state);
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '[data-view-doc]', async (event, link) => {
    event.preventDefault();
    try { const url = await customerDocumentUrl(restaurant[CUSTOMER_DOCUMENTS[link.dataset.viewDoc].column]); window.open(url, '_blank', 'noopener'); }
    catch (error) { reportError(error); }
  });

  on(container, 'click', '#use-location', async (_e, button) => {
    try {
      const { lat, lng } = await withBusy(button, currentPosition);
      await updateMyLocation(lat, lng);
      Object.assign(restaurant, { lat, lng });
      toast('Map pin saved', 'success');
      renderAccount(container, state);
    } catch (error) { reportError(error); }
  });
  on(container, 'click', '#clear-location', async (_e, button) => {
    try { await withBusy(button, () => updateMyLocation(null, null)); Object.assign(restaurant, { lat: null, lng: null }); toast('Pin removed', 'success'); renderAccount(container, state); }
    catch (error) { reportError(error); }
  });

  on(container, 'submit', '#account-form', async (event, form) => {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    if (!form.checkValidity()) { reportError(new Error('Pin code must be 6 digits.')); return; }
    try {
      let delivers = state.terms?.delivers;
      await withBusy($('button[type="submit"]', form), async () => {
        await updateMyProfile({ fullName: v.fullName, phone: v.phone });
        if (restaurant && isOwner) {
          await updateMyRestaurant({ name: v.name, address: v.address, phone: v.rphone, gstin: v.gstin, fssai: v.fssai });
          const areaChanged = v.cityId !== restaurant.city_id || (v.pincode || null) !== (restaurant.pincode || null);
          if (areaChanged && v.cityId) ({ delivers } = await updateMyDeliveryArea({ cityId: v.cityId, pincode: v.pincode }));
        }
      });
      // Keep in-memory copies fresh so the header/banner stay correct.
      Object.assign(state.me.profile, { full_name: v.fullName, phone: v.phone });
      if (restaurant && isOwner) Object.assign(restaurant, { name: v.name, address: v.address, phone: v.rphone, gstin: v.gstin, fssai: v.fssai, city_id: v.cityId || restaurant.city_id, pincode: v.pincode || null });
      if (restaurant && state.terms) state.terms = await getMyOrderTerms().catch(() => state.terms);
      toast(delivers === false ? 'Saved. We do not deliver to that pin code yet.' : 'Saved', delivers === false ? 'info' : 'success');
    } catch (error) { reportError(error); }
  });
}
