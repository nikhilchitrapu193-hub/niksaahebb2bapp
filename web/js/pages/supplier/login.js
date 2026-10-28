// web/js/pages/supplier/login.js
// Supplier portal login — handles invite-token magic-link and OTP login
import { getSupabase } from '../../core/supabase.js';

const ROOT = document.getElementById('root');

function render() {
  const params = new URLSearchParams(location.search);
  const token  = params.get('token');

  ROOT.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">
          <img src="/icons/icon-192.png" alt="Fresh Supply" width="48" height="48">
          <h1>Supplier Portal</h1>
        </div>

        ${token ? `
        <p class="auth-subtitle">You've been invited to Fresh Supply. Enter your email to continue.</p>
        <form id="invite-form">
          <div class="form-group">
            <label for="email">Work Email</label>
            <input id="email" type="email" required placeholder="you@company.com" autocomplete="email">
          </div>
          <div class="form-group">
            <label for="password">Set Password</label>
            <input id="password" type="password" required minlength="8" placeholder="Min 8 characters">
          </div>
          <button type="submit" class="btn btn-primary btn-full" id="submit-btn">Activate Account</button>
          <div id="form-error" class="form-error" style="display:none"></div>
        </form>
        ` : `
        <p class="auth-subtitle">Sign in to your supplier account.</p>
        <form id="login-form">
          <div class="form-group">
            <label for="email">Work Email</label>
            <input id="email" type="email" required placeholder="you@company.com" autocomplete="email">
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input id="password" type="password" required placeholder="Your password" autocomplete="current-password">
          </div>
          <button type="submit" class="btn btn-primary btn-full" id="submit-btn">Sign In</button>
          <div id="form-error" class="form-error" style="display:none"></div>
        </form>
        `}
      </div>
    </div>
  `;

  const form  = document.querySelector('form');
  const errEl = document.getElementById('form-error');

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn   = document.getElementById('submit-btn');
    const email = document.getElementById('email').value.trim();
    const pass  = document.getElementById('password').value;

    btn.disabled = true;
    btn.textContent = token ? 'Activating…' : 'Signing in…';
    errEl.style.display = 'none';

    try {
      const sb = getSupabase();

      if (token) {
        // Activate via invite token — verify token belongs to this email
        const { data: invite, error: invErr } = await sb
          .from('supplier_invites')
          .select('id, supplier_id, expires_at, used_at')
          .eq('token', token)
          .eq('email', email)
          .maybeSingle();

        if (invErr || !invite) {
          showError('Invalid invite link or email mismatch.');
          return;
        }
        if (invite.used_at) {
          showError('This invite has already been used.');
          return;
        }
        if (new Date(invite.expires_at) < new Date()) {
          showError('This invite has expired. Contact your Fresh Supply account manager.');
          return;
        }

        // Sign up or sign in (idempotent)
        const { error: signUpErr } = await sb.auth.signUp({ email, password: pass });
        if (signUpErr && !signUpErr.message.includes('already registered')) {
          showError(signUpErr.message);
          return;
        }

        // Sign in to get session
        const { error: signInErr } = await sb.auth.signInWithPassword({ email, password: pass });
        if (signInErr) { showError(signInErr.message); return; }

        // Mark invite used (edge function would handle this; fallback direct upsert)
        await sb.from('supplier_invites').update({ used_at: new Date().toISOString() }).eq('id', invite.id);

        location.replace('/supplier/');
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) { showError(error.message); return; }
        location.replace('/supplier/');
      }
    } catch (err) {
      showError('An unexpected error occurred. Please try again.');
      console.error(err);
    } finally {
      btn.disabled = false;
      btn.textContent = token ? 'Activate Account' : 'Sign In';
    }
  });
}

render();
