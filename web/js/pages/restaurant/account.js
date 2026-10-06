// =============================================================================
// account.js — edit contact details and restaurant info.
// =============================================================================

import { html, mount, on, $, withBusy, toast, reportError, statusBadge } from '../../core/ui.js';
import { updateMyProfile, updateMyRestaurant } from '../../core/api.js';

export function renderAccount(container, state) {
  const { profile, restaurant, user } = state.me;
  mount(container, html`
    <div class="page-head"><div><h1>Account</h1><p>${user.email}</p></div>${restaurant ? statusBadge(restaurant.status) : ''}</div>
    <form class="card card-pad stack" id="account-form">
      <h2>Restaurant details</h2>
      <div class="form-grid">
        <label class="field"><span class="label">Restaurant name</span><input class="input" name="name" value="${restaurant?.name ?? ''}" required maxlength="120"></label>
        <label class="field"><span class="label">Restaurant phone</span><input class="input" name="rphone" value="${restaurant?.phone ?? ''}" maxlength="20"></label>
        <label class="field span-2"><span class="label">Delivery address</span><textarea class="textarea" name="address" rows="2" maxlength="300">${restaurant?.address ?? ''}</textarea></label>
        <label class="field"><span class="label">FSSAI licence no.</span><input class="input" name="fssai" value="${restaurant?.fssai ?? ''}" maxlength="20"></label>
        <label class="field"><span class="label">GSTIN (optional)</span><input class="input" name="gstin" value="${restaurant?.gstin ?? ''}" maxlength="15"></label>
      </div>
      <h2>Your contact</h2>
      <div class="form-grid">
        <label class="field"><span class="label">Your name</span><input class="input" name="fullName" value="${profile.full_name ?? ''}" maxlength="120"></label>
        <label class="field"><span class="label">Your phone</span><input class="input" name="phone" value="${profile.phone ?? ''}" maxlength="20"></label>
      </div>
      <div><button class="btn primary" type="submit">Save changes</button></div>
    </form>`);

  on(container, 'submit', '#account-form', async (event, form) => {
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    try {
      await withBusy($('button[type="submit"]', form), async () => {
        await updateMyProfile({ fullName: v.fullName, phone: v.phone });
        if (restaurant) await updateMyRestaurant({ name: v.name, address: v.address, phone: v.rphone, gstin: v.gstin, fssai: v.fssai });
      });
      // Keep in-memory copies fresh so the header/banner stay correct.
      Object.assign(state.me.profile, { full_name: v.fullName, phone: v.phone });
      if (restaurant) Object.assign(restaurant, { name: v.name, address: v.address, phone: v.rphone, gstin: v.gstin, fssai: v.fssai });
      toast('Saved', 'success');
    } catch (error) { reportError(error); }
  });
}
