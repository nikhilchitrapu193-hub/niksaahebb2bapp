# Deployment

The app is a folder of static files (`web/`). There is nothing to build.

## 1. Database (once)
Migrations are already applied to the project named in `web/js/core/config.js`. For a new project,
run the files in `supabase/migrations/` in order in the Supabase SQL editor, then `supabase/seed.sql`,
and put the new project URL and publishable key into `config.js`.

## 2. Supabase settings
* **Authentication → URL configuration:** set *Site URL* to your live address and add it plus
  `http://localhost:3000/**` to *Redirect URLs* (needed for password-reset links).
* **Authentication → Providers → Email:** decide whether to keep *Confirm email* on.
  On = safer; Off = faster testing.
* Free-tier note: projects pause after a week of inactivity. Keep it active or upgrade before launch.

## 3. Host the files (all free)
Upload the contents of `web/` to any static host: Cloudflare Pages, Netlify, GitHub Pages, Vercel.
Set the publish directory to `web` and leave the build command empty.

## 4. First admin
Follow [runbook.md](runbook.md#bootstrap-the-first-admin).

## Before real customers
* Replace the sample prices (Admin → Products) with your real ones.
* Configure a custom SMTP sender in Supabase (the built-in email is rate-limited).
* Review Supabase **Advisors**; the `SECURITY DEFINER` warnings are intentional ([ADR 0002](adr/0002-no-custom-api-server.md)).
* Do a full manual pass in a real browser (register → approve → order → assign → dispatch → deliver).
