# Patch guide — Customer access hotfix: a sign-up never dead-ends on an email (22 Oct 2026)

**What happened.** The first cantonment sign-up ("mess1") was created correctly, but the confirmation email Supabase
sent from its built-in mailer (`noreply@mail.app.supabase.io`) never reached the inbox, sign-in then failed with
"Email not confirmed", and neither the login page nor the admin app had a way out. **I have already confirmed that
account on the live project** (it shows in the Audit log) — approve it under Customers and it can sign in and order.

**What this patch adds** (migration 016 — **already applied live**, Edge Function `customer-access` — **already deployed**):
* **Login page:** after registering, and whenever sign-in says "email not confirmed", a **Resend the confirmation
  email** button; the text says to check spam and to call us.
* **Customers screen:** a **Login** column (email · confirmed / *not confirmed — cannot sign in*), a banner counting
  customers who cannot sign in, and an **Access** button with four backups, lightest first: *Resend confirmation* ·
  *Confirm email now* · *Password link* (one-time, with **Send on WhatsApp** to the number on file, or copy) ·
  *Temporary password* (tell them by phone). Each is audited. Approving a still-unconfirmed customer is allowed and the
  toast says to use Access.
* **Docs:** runbook section "When a customer cannot sign in", deployment guidance to set a custom SMTP sender (Resend
  / Brevo free tiers) or to switch *Confirm email* off since approval is already the gate, ADR 0020.

Tested: `npm test` 117/117 · `security_test.sql` 242/242 · both screens rendered in headless Chromium.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)
1. Unzip `fresh-supply-customer-access-hotfix.zip` into the repo root — 22 files (4 new, 18 modified). Say **yes** to replacing.
2. `npm test` → `# pass 117`.
3. `git add -A` → `git commit -m "Customer access: resend, confirm, link, temporary password (016)"` → `git push origin main`.
4. Database and function: **nothing to run** — migration 016 and the `customer-access` function are live. (If you ever
   rebuild the project: `supabase/migrations/20261022000001_customer_access.sql` applies through the Supabase tool or
   the SQL editor; `supabase functions deploy customer-access`.)
5. Decide the mailer, once (Supabase dashboard): **Authentication → Providers → Email → Confirm email: off** is the
   simplest for launch (you approve every customer anyway); otherwise **Authentication → SMTP** with a Resend or Brevo
   account so confirmation and password emails arrive reliably. Steps in `docs/deployment.md` §2.
6. Try it: Admin → Customers → **mess1** → **Approve**; then **Access** on any row to see the four options.

## Files — NEW (4)
| Path | What it is |
|---|---|
| `supabase/migrations/20261022000001_customer_access.sql` | migration 016: `admin_customer_logins()` (applied live) |
| `supabase/functions/customer-access/index.ts` | Edge Function: confirm / resend / password link / temporary password, audited (deployed live) |
| `docs/adr/0020-customer-access-never-stuck.md` | decision record |
| `docs/patches/2026-10-22-customer-access-hotfix.md` | this guide |

## Files — MODIFIED (18)
| Path | What changed |
|---|---|
| `web/js/pages/login.js` | Resend button after registering and on "email not confirmed"; plain-words message; "call us" |
| `web/js/core/auth.js` | `resendConfirmation(email)` |
| `web/js/core/api.js` | `listCustomerLogins()`, `customerAccess(action, restaurantId, { password })` |
| `web/js/pages/admin/customers.js` | Login column, cannot-sign-in banner, **Access** dialog, CSV email columns, approve toast |
| `supabase/tests/security_test.sql` | T61 (242 checks); `supabase/tests/local_postgres_stub.sql` gains the two auth.users columns it reads |
| `tests/helpers/fake-supabase.js`, `tests/pages.test.js` | `auth.resend` + an unconfirmed login in the fake; two new screen tests |
| `docs/runbook.md`, `docs/deployment.md`, `docs/api.md`, `docs/roles.md`, `docs/testing.md`, `docs/build-roadmap.md`, `docs/adr/README.md`, `README.md`, `AGENTS.md`, `CLAUDE.md` | the new section, SMTP / confirm-email guidance, function and RPC rows, counts |
