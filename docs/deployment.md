# Deployment

The app is a folder of static files (`web/`). There is nothing to build.

## 1. Database (once)
Migrations are already applied to the project named in `web/js/core/config.js`. For a new project,
run the files in `supabase/migrations/` in order in the Supabase SQL editor, then `supabase/seed.sql`,
and put the new project URL and publishable key into `config.js`.

### Applying migrations
Each migration is one file, applied once, never edited afterwards (AGENTS.md rule 4). Two ways:
* **Supabase SQL editor** — paste the file, run it. Works for every migration. The editor warns before a
  statement that changes or removes rows without a WHERE; the migrations only ever do that inside a
  function with a WHERE, so answer *Run* when it asks.
* **Supabase MCP tool** (`apply_migration`, used by the coding agent) — also records the migration in the
  project's history, but it refuses any migration whose text contains a `DROP` or a row-removal
  statement, even inside a function body. Migrations 001–010 were applied this way; **011 (`procurement`), 012 (`fulfilment`), 013 (`orders_plus`)
  and 014 (`launch_control`) contain such a statement inside a function and must be applied from the SQL editor** (013's `edit_order`
  and 014's replacement of `rebuild_order_lines` clear an order's lines with a DELETE). 015 (`payments_credit`) has none.
  Do not rewrite a migration to disguise the statement from the tool.

## 2. Supabase settings
* **Authentication → URL configuration:** set *Site URL* to your live address and add it plus
  `http://localhost:3000/**` to *Redirect URLs* (needed for password-reset links).
* **Authentication → Providers → Email:** decide whether to keep *Confirm email* on. Every customer is approved by a
  person before they can order, so switching it **off** removes the step that most often strands a new customer (the
  built-in mailer is slow, rate-limited and lands in spam). If you keep it on, set up SMTP (next point). Either way the
  app has backups: customers can resend the email; staff can confirm, send a link or set a password from Customers →
  Access (migration 016, `docs/runbook.md`).
* **Authentication → SMTP settings (recommended before launch):** the built-in sender
  (`noreply@mail.app.supabase.io`) is for testing only — a few emails an hour, often filtered. Create a free account at
  Resend (3,000 emails / month) or Brevo (300 / day), verify your sending domain or address, and enter host, port,
  user, password and sender name here. Confirmation, password-reset and staff-invite emails then arrive reliably.
* Free-tier note: projects pause after a week of inactivity. Keep it active or upgrade before launch.

## 3. Host the files (all free)
Upload the contents of `web/` to any static host: Cloudflare Pages, Netlify, GitHub Pages, Vercel.
Set the publish directory to `web` and leave the build command empty.

## 4. First admin
Follow [runbook.md](runbook.md#bootstrap-the-first-admin).

## 5. Launch switches
Settings → Launch decides who can order and how much of the app the team sees (`docs/modules/launch-control.md`).
For the first launch: army cantonments on, the other sectors off, pricing **Simple**, stock **Simple**.

## 6. Online payments (optional, Razorpay)
Create keys and a webhook in the Razorpay dashboard, set the secrets `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET` under Edge Functions, deploy `razorpay-order` and `razorpay-webhook` (the webhook with
`--no-verify-jwt`), then put the key id into `config.js` → `razorpayKeyId`. Steps in `docs/modules/payments.md`. Until
then the customer app shows no "Pay online" button and receipts are recorded by staff.

## Before real customers
* Replace the sample prices (Admin → Products) with your real ones.
* Configure a custom SMTP sender in Supabase (section 2) — or switch *Confirm email* off.
* Edge Functions deployed: `invite-staff`, `customer-access` (this one is live on the project already), and when you have Razorpay keys, `razorpay-order` / `razorpay-webhook`.
* Review Supabase **Advisors**; the `SECURITY DEFINER` warnings are intentional ([ADR 0002](adr/0002-no-custom-api-server.md)).
* Do a full manual pass in a real browser (register → approve → order → assign → dispatch → deliver).
