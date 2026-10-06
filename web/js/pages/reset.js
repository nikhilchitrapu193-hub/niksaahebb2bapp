// =============================================================================
// reset.js — choose a password after following an emailed link: either a
// password RESET or a staff INVITE (?role=admin|delivery). Supabase puts a
// session in the URL; supabase-js picks it up automatically
// (detectSessionInUrl), so we just call updatePassword().
// =============================================================================

import { html, mount, $, on, withBusy } from '../core/ui.js';
import { updatePassword, getSession } from '../core/auth.js';
import { supabase } from '../core/supabase.js';
import { ROLE_LOGIN } from '../core/config.js';

// Invitees arrive with ?role=…; send them to the matching login afterwards.
const role = new URLSearchParams(location.search).get('role');
const nextLogin = `./${ROLE_LOGIN[role] ?? ROLE_LOGIN.restaurant}`;
const isInvite = Boolean(ROLE_LOGIN[role]);

const root = $('#auth-root');

function render(message = '') {
  mount(root, html`
    <div class="brand"><span class="brand-mark">F</span><span>Fresh Supply</span></div>
    <h1>${isInvite ? 'Welcome — set your password' : 'Choose a new password'}</h1>
    <form id="form" class="stack" style="margin-top:var(--space-5)" novalidate>
      <label class="field"><span class="label">New password</span>
        <input class="input" type="password" name="password" autocomplete="new-password" minlength="8" required>
        <span class="hint">At least 8 characters.</span></label>
      <button class="btn primary block" type="submit">Save password</button>
      <p class="form-error" id="error" role="alert">${message}</p>
    </form>`);
}

on(root, 'submit', '#form', async (event, form) => {
  event.preventDefault();
  if (!form.checkValidity()) { $('#error').textContent = 'Password must be at least 8 characters.'; return; }
  try {
    await withBusy($('button', form), async () => {
      await updatePassword(form.elements.password.value);
      mount(root, html`<div class="banner info">Password updated.</div><a class="btn primary block" href="${nextLogin}">Continue to sign in</a>`);
      await supabase.auth.signOut();
    });
  } catch (error) {
    $('#error').textContent = error.message;
  }
});

// The recovery session may arrive a moment after load; wait for it briefly.
(async () => {
  let session = await getSession();
  if (!session) {
    await new Promise((r) => setTimeout(r, 800));
    session = await getSession();
  }
  render(session ? '' : 'This reset link is invalid or has expired. Request a new one from the sign-in page.');
})();
