// =============================================================================
// login.js — the sign-in page shared by the three login areas.
//
// Each area is its own HTML page (restaurant/login.html, admin/login.html,
// delivery/login.html) that sets data-role on #auth-root. The same module
// renders the right form for that role:
//   restaurant → Sign in / Register tabs
//   admin, delivery → Sign in only (staff accounts are created by invitation)
// An account that signs in on the wrong page is signed out again with a hint,
// so a restaurant cannot wander into the admin area even by accident. (The
// database enforces the real restriction; this is just a clear message.)
//
// Nobody gets stuck on the confirmation email: after registering, and whenever
// sign-in fails with "email not confirmed", a Resend button sends it again, and
// the text says to call us — staff can confirm the account from their side
// (Customers → Access, migration 016).
// =============================================================================

import { html, mount, $, on, withBusy } from '../core/ui.js';
import { signIn, signUpRestaurant, signUpStaff, requestPasswordReset, resendConfirmation, loadCurrentUser, homeFor, loginFor } from '../core/auth.js';
import { claimFirstAdmin, listCities, listSectors } from '../core/api.js';
import { supabase } from '../core/supabase.js';
import { ROLE_LABELS, webRoot } from '../core/config.js';

const root = $('#auth-root');
const ROLE = root.dataset.role;             // 'restaurant' | 'admin' | 'delivery'
const canRegister = ROLE === 'restaurant';
const canSetup = ROLE === 'admin';          // first-admin setup, works only while no admin exists
let mode = (canRegister && location.hash === '#register') ? 'register' : 'signin'; // 'signin' | 'register' | 'setup' | 'forgot'

// Cities and sectors for the register form (public lists). Every active sector
// with can_self_register (all of them unless switched off under Settings →
// Sectors) is offered; the hint under the dropdown shows what the sector gets.
let cities = [];
let sectors = [];
let lastEmail = '';     // the address typed last, for "Resend confirmation email"

const stuckHelp = html`<p class="muted small">Check your spam folder too. Still nothing after a few minutes? Call us — we can activate your account from our side.</p>`;

const brand = html`<div class="brand"><span class="brand-mark">F</span><span>Fresh Supply</span><span class="brand-sub">${ROLE_LABELS[ROLE]}</span></div>`;

function banners() {
  const reason = new URLSearchParams(location.search).get('reason');
  if (reason === 'disabled') return html`<div class="banner error">This account has been deactivated. Contact your administrator.</div>`;
  if (reason === 'wrong-role') return html`<div class="banner warn">That account does not belong to this login area. Use the links below to find the right one.</div>`;
  return '';
}

const otherLogins = html`<p class="muted small center" style="margin-top:var(--space-5)">
  ${['restaurant', 'admin', 'delivery'].filter((r) => r !== ROLE).map((r, i) =>
    html`${i ? ' · ' : ''}<a href="${loginFor(r)}">${ROLE_LABELS[r]} login</a>`)}
  · <a href="${webRoot}">Home</a></p>`;

function view() {
  if (mode === 'forgot') {
    return html`${brand}
      <h1>Reset password</h1>
      <p class="muted" style="margin:var(--space-2) 0 var(--space-5)">We'll email you a link to choose a new password.</p>
      <form id="form" class="stack" novalidate>
        <label class="field"><span class="label">Email</span><input class="input" type="email" name="email" autocomplete="email" required></label>
        <button class="btn primary block" type="submit">Send reset link</button>
        <button class="btn ghost block" type="button" data-mode="signin">Back to sign in</button>
        <p class="form-error" id="error" role="alert"></p>
      </form>${otherLogins}`;
  }

  if (mode === 'setup') {
    return html`${brand}
      <h1>First-time setup</h1>
      <p class="muted" style="margin:var(--space-2) 0 var(--space-5)">Create the first administrator account. This only works while the system has no admin yet; after that, admins are added from the Team screen.</p>
      <form id="form" class="stack" novalidate>
        <label class="field"><span class="label">Your name</span><input class="input" name="fullName" autocomplete="name" required maxlength="120"></label>
        <label class="field"><span class="label">Phone</span><input class="input" name="phone" type="tel" maxlength="20"></label>
        <label class="field"><span class="label">Email</span><input class="input" type="email" name="email" autocomplete="email" required></label>
        <label class="field"><span class="label">Password</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></label>
        <button class="btn primary block large" type="submit">Create admin account</button>
        <button class="btn ghost block" type="button" data-mode="signin">Back to sign in</button>
        <p class="form-error" id="error" role="alert"></p>
      </form>${otherLogins}`;
  }

  const tabs = canRegister ? html`<div class="seg" role="tablist">
      <button type="button" role="tab" data-mode="signin" aria-selected="${String(mode === 'signin')}">Sign in</button>
      <button type="button" role="tab" data-mode="register" aria-selected="${String(mode === 'register')}">Register</button>
    </div>` : html`<h1 style="margin-bottom:var(--space-5)">${ROLE_LABELS[ROLE]} sign in</h1>`;

  if (mode === 'register') {
    return html`${brand}${tabs}
      <form id="form" class="stack" novalidate>
        <label class="field"><span class="label">Business / outlet name</span><input class="input" name="restaurantName" required maxlength="120"><span class="hint">Restaurant, hotel, hospital, mess, canteen or shop</span></label>
        <div class="form-grid">
          <label class="field"><span class="label">Your name</span><input class="input" name="fullName" autocomplete="name" required maxlength="120"></label>
          <label class="field"><span class="label">Phone</span><input class="input" name="phone" type="tel" autocomplete="tel" required maxlength="20"></label>
        </div>
        ${sectors.length > 1 ? html`<label class="field"><span class="label">Type of business</span><select class="select" name="sectorCode">
          ${sectors.map((s) => html`<option value="${s.code}">${s.name}</option>`)}</select>
          <span class="hint" id="sector-hint">${sectors[0]?.description ?? ''}</span></label>` : ''}
        <label class="field"><span class="label">Delivery address</span><textarea class="textarea" name="address" rows="2" required maxlength="300"></textarea></label>
        <div class="form-grid">
          <label class="field"><span class="label">City</span>${cities.length
            ? html`<select class="select" name="cityId">${cities.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>`
            : html`<input class="input" value="Visakhapatnam" disabled><input type="hidden" name="cityId" value="">`}</label>
          <label class="field"><span class="label">Pin code</span><input class="input" name="pincode" required pattern="[1-9][0-9]{5}" maxlength="6" inputmode="numeric" placeholder="530001"><span class="hint">Tells us which warehouse serves you</span></label>
        </div>
        <div class="form-grid">
          <label class="field"><span class="label">FSSAI licence no.</span><input class="input" name="fssai" maxlength="20" placeholder="14 digits"><span class="hint">Needed before approval</span></label>
          <label class="field"><span class="label">GSTIN (optional)</span><input class="input" name="gstin" maxlength="15"></label>
        </div>
        <label class="field"><span class="label">Email</span><input class="input" type="email" name="email" autocomplete="email" required></label>
        <label class="field"><span class="label">Password</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></label>
        <button class="btn primary block large" type="submit">Create account</button>
        <p class="muted small">New accounts are reviewed by our team before you can place orders.</p>
        <p class="form-error" id="error" role="alert"></p>
      </form>${otherLogins}`;
  }

  return html`${brand}${tabs}${banners()}
    <form id="form" class="stack" novalidate>
      <label class="field"><span class="label">Email</span><input class="input" type="email" name="email" autocomplete="email" required></label>
      <label class="field"><span class="label">Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary block large" type="submit">Sign in</button>
      <button class="btn ghost block" type="button" data-mode="forgot">Forgot password?</button>
      <p class="form-error" id="error" role="alert"></p>
      <div id="not-confirmed" hidden>${stuckHelp}<button class="btn block" type="button" data-resend>Resend the confirmation email</button></div>
    </form>
    ${canRegister ? '' : html`<p class="muted small center">Staff accounts are created by an administrator.${canSetup ? html` <a href="#" data-mode="setup">First time here? Set up the first admin.</a>` : ''}</p>`}
    ${otherLogins}`;
}

function render() { mount(root, view()); }
function showError(message) { const el = $('#error', root); if (el) el.textContent = message; }

on(root, 'click', '[data-mode]', (e, el) => { e.preventDefault(); mode = el.dataset.mode; render(); });
on(root, 'change', '[name=sectorCode]', (_e, el) => {
  const hint = $('#sector-hint', root);
  if (hint) hint.textContent = sectors.find((s) => s.code === el.value)?.description ?? '';
});

on(root, 'submit', '#form', async (event, form) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const button = $('button[type="submit"]', form);
  lastEmail = values.email || lastEmail;
  showError('');
  if (!form.checkValidity()) { showError('Please fill in all required fields correctly.'); return; }

  try {
    await withBusy(button, async () => {
      if (mode === 'signin') {
        await signIn(values.email, values.password);
        await redirectHome();
      } else if (mode === 'setup') {
        const { needsEmailConfirmation } = await signUpStaff(values);
        if (needsEmailConfirmation) {
          mount(root, html`${brand}<div class="banner info">Account created. Confirm your email, then sign in here — the first sign-in becomes the admin.</div>
            <button class="btn block" data-mode="signin">Go to sign in</button>`);
        } else {
          await redirectHome();
        }
      } else if (mode === 'register') {
        const { needsEmailConfirmation } = await signUpRestaurant(values);
        if (needsEmailConfirmation) {
          lastEmail = values.email;
          mount(root, html`${brand}<div class="banner info">Account created. Check your email (${values.email}) to confirm your address, then sign in.</div>
            ${stuckHelp}
            <button class="btn block" data-resend>Didn't get it? Resend the confirmation email</button>
            <button class="btn ghost block" data-mode="signin">Go to sign in</button>`);
        } else {
          await redirectHome();
        }
      } else {
        await requestPasswordReset(values.email);
        mount(root, html`${brand}<div class="banner info">If that email has an account, a reset link is on its way.</div>
          <button class="btn block" data-mode="signin">Back to sign in</button>`);
      }
    });
  } catch (error) {
    showError(friendly(error.message));
    // The one failure a customer can fix themselves: the confirmation email never arrived.
    if (/email not confirmed/i.test(error.message)) { const box = $('#not-confirmed', root); if (box) box.hidden = false; }
  }
});

on(root, 'click', '[data-resend]', async (e, button) => {
  e.preventDefault();
  if (!lastEmail) { showError('Type your email above first.'); return; }
  try {
    await withBusy(button, () => resendConfirmation(lastEmail));
    button.replaceWith(mountNotice(`Sent again to ${lastEmail}. Give it a few minutes and check spam.`));
  } catch (error) {
    // Supabase allows only a few emails an hour per address; say what to do instead.
    button.replaceWith(mountNotice(/rate limit|too many|seconds/i.test(error.message)
      ? 'Too many emails in a short time. Wait a few minutes, or call us and we will activate your account.'
      : error.message));
  }
});

/** A small inline notice that takes the place of a button once it has done its job. */
function mountNotice(text) {
  const p = document.createElement('p');
  p.className = 'banner info';
  p.textContent = text;
  return p;
}

/** Replace cryptic auth messages with plain language. */
function friendly(message) {
  if (/invalid login credentials/i.test(message)) return 'Incorrect email or password.';
  if (/already registered/i.test(message)) return 'An account with this email already exists. Try signing in.';
  if (/email not confirmed/i.test(message)) return 'Your email is not confirmed yet. Use the link we emailed you, or resend it below.';
  return message;
}

/** After a successful sign-in: go to this role's app, or reject other roles. */
async function redirectHome() {
  const me = await loadCurrentUser();
  if (!me?.profile) throw new Error('This account is deactivated. Contact your administrator.');
  if (me.profile.role !== ROLE && ROLE === 'admin' && !me.restaurant) {
    // A staff login with no admin yet: the first one to sign in here becomes admin.
    if (await claimFirstAdmin()) { location.href = homeFor(ROLE); return; }
  }
  if (me.profile.role !== ROLE) {
    await supabase.auth.signOut();
    throw new Error(`This is a ${ROLE_LABELS[me.profile.role].toLowerCase()} account. Please use the ${ROLE_LABELS[me.profile.role]} login.`);
  }
  location.href = homeFor(ROLE);
}

// Already signed in with the right role? Skip the form.
(async () => {
  try {
    const me = await loadCurrentUser();
    if (me?.profile?.role === ROLE) { location.replace(homeFor(ROLE)); return; }
  } catch (error) { console.error(error); }
  if (canRegister) {
    // Lists are public; if they fail the form still works (the database falls back to the first city).
    // Two named rules (both under Settings): the sector is live (is_active, Settings → Launch)
    // and allows self sign-up (can_self_register, Settings → Sectors). The database applies the same two.
    try { [cities, sectors] = await Promise.all([listCities(), listSectors().then((all) => all.filter((x) => x.is_active && x.can_self_register))]); } catch (error) { console.error(error); }
  }
  render();
})();
