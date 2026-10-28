# Patch guide — Batch 9: Notifications & support (27 Oct 2026)

Batch 9 of the Phase 1 roadmap, the first of the "batch 9 + 10 + Phase 2" run. The sequence for everything that
follows is in `docs/phase2-plan.md`.

**What's new** (migration 018 — **already applied live**; Edge Function `send-notifications` — **already deployed**):
* **Customers get SMS / email automatically** when an order is placed, confirmed, out for delivery, delivered or
  cancelled, when you record a receipt, the day before a credit invoice is due and while it is overdue (weekly),
  when support replies, and when their account is approved. Templates per event — and per sector where wording should
  differ — under **Settings → Notifications → Templates**, with a live preview.
* **Nothing is sent from the app.** The database queues every message into an outbox; the `send-notifications`
  function sends them through whichever provider you configure (SMS: **httpSMS** on your own Android phone + SIM, free;
  or **MSG91**; email: **Resend** or **Brevo**). Until you configure one, messages are logged as *skipped* with the
  reason — so you can see what customers *would* receive; **Retry** sends them once a provider is in.
  Setting a provider is a one-time step: `docs/deployment.md` §7 (secrets + a 5-minute scheduler). **Send now** and
  **Check queue** buttons on the Message log run it by hand.
* **Support channels** (Settings → Notifications → Support channels): your phone, WhatsApp and email appear on the
  website footer, the customer's Help page, and as **Call · WhatsApp** links on Customers, every order, every ticket and
  the driver's delivery card (WhatsApp pre-fills the order / ticket number).
* **Support tickets**: customers raise them from the new **Help** page (optionally about an order); you answer under
  **Orders → Support tickets** (reply, assign, priority, resolve / close; a reply notifies the customer). Staff can open
  a ticket for a customer after a call.
* **Help centre** (Settings → Help centre): plain-text articles with an audience — *Everyone* also becomes the FAQ on
  the public website; *Customers* shows under Help in the app; *Delivery staff* for drivers. 8 starter articles seeded.
* **Map pin**: "Use my location" at sign-up and under Account stores the exact gate; the driver's map opens on the pin
  instead of searching the address. Staff see *Map pin / Find on map* on Customers.
* **Backups & monitoring** are now a runbook section (`docs/runbook.md`), with a five-minute morning check.
* **Deliberately out:** phone-OTP sign-in (ADR 0023: a SIM gateway is fine for notifications, not for the login path).
  Two decision records: ADR 0022 (Phase 2 stays with no framework), ADR 0023 (outbox + providers).

Tested: `npm test` **131/131** · `security_test.sql` **263/263** (15 new T63 checks) on a clean local Postgres ·
14 screens rendered in headless Chromium with no console errors (templates, template editor with preview, support
channels, message log + Send now, tickets list + detail, help-centre editor, customers with contact links, customer
Help + ticket thread, Account map pin, driver card with pin + WhatsApp, website FAQ/footer, register form with
"Use my location").

**Live project (bzxygscjhvcwahwqgqin):** migration 018 applied (10 templates, 8 articles, 3 triggers verified);
`send-notifications` deployed (version 1, JWT check on). No provider secrets are set yet, so messages will log as
*skipped* until you do §7 of `docs/deployment.md`.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)
1. Unzip `fresh-supply-batch9-notifications.zip` into the repo root — **42 files (13 new, 29 modified)**. Say **yes** to replacing.
2. `npm test` → `# pass 131`.
3. `git add -A` → `git commit -m "Batch 9: notifications & support (018)"` → `git push origin main`.
   (Batches 7–8 and the two hotfixes are still only on your machine until you push — origin/main is at the batch-6 commit.)
4. Database / functions: **nothing to run** — 018 is live and `send-notifications` is deployed.
5. **Switch on sending when ready:** `docs/deployment.md` §7 — httpSMS on a company phone (free) and Resend for email,
   set the secrets, add the 5-minute scheduler on cron-job.org, then Settings → Notifications → *Check queue* shows the
   providers and *Send now* drains the queue. Fill **Support channels** (phone / WhatsApp / email) in the same screen.
6. Try it: place an order as a customer → Settings → Notifications → Message log shows the "order placed" SMS + email
   (skipped until a provider is set). Raise a ticket from the customer's Help page → answer it under Orders → Support tickets.

## Files — NEW (13)
| Path | What it is |
|---|---|
| `supabase/migrations/20261027000001_notifications_support.sql` | migration 018 (applied live) |
| `supabase/functions/send-notifications/index.ts` | the sender (deployed): providers httpsms / msg91 / resend / brevo / none |
| `web/js/core/notify.js` | `renderTemplate`, `phoneDigits`, `telHref`, `whatsappHref`, `mapHref`, `contactLinks`, `SAMPLE_VALUES` |
| `web/js/core/geo.js` | `currentPosition()` — browser geolocation with readable errors |
| `web/js/pages/admin/notifications.js` | Settings → Notifications: Templates · Support channels · Message log |
| `web/js/pages/admin/tickets.js` | Orders → Support tickets |
| `web/js/pages/admin/help-centre.js` | Settings → Help centre |
| `web/js/pages/restaurant/help.js` | customer Help page: contact buttons, tickets, FAQ |
| `docs/modules/notifications.md` | module doc |
| `docs/adr/0022-no-framework-for-phase-2.md` | decision: no framework for Phase 2 |
| `docs/adr/0023-notification-outbox-and-providers.md` | decision: outbox + provider interface, no phone-OTP |
| `docs/phase2-plan.md` | the batch 9 → P2-8 sequence |
| `docs/patches/2026-10-27-notifications-support-batch.md` | this guide |

## Files — MODIFIED (29)
| Path | What changed |
|---|---|
| `web/js/core/config.js` | `NOTIFICATION_EVENTS` (with allowed placeholders), `NOTIFICATION_CHANNELS`, `NOTIFICATION_STATUSES`, `TICKET_STATUSES`, `TICKET_PRIORITIES`, `HELP_AUDIENCES` |
| `web/js/core/api.js` | "Notifications, support & help" section: settings, log, retry, `sendNotificationsNow`, `getSupportChannels`, tickets, help articles, `getDeliveryPins`, `updateMyLocation` |
| `web/js/core/auth.js` | `signUpRestaurant` passes `lat` / `lng` metadata |
| `web/js/pages/admin/main.js` | routes `#notifications`, `#help-centre` (Settings), `#tickets` (Orders) |
| `web/js/pages/admin/settings.js` | tabs Notifications, Help centre |
| `web/js/pages/admin/orders.js` | Support tickets button; Call · WhatsApp on the order detail |
| `web/js/pages/admin/customers.js` | Call · WhatsApp + Map pin / Find on map per customer |
| `web/js/pages/restaurant/main.js` | Help route + nav |
| `web/js/pages/restaurant/account.js` | Map pin: Use my location / View pin / Remove pin |
| `web/js/pages/restaurant/orders.js` | "Need help? Raise a ticket" link on the order detail |
| `web/js/pages/delivery/main.js` | Open map pin (`delivery_pins`) + WhatsApp button |
| `web/js/pages/login.js` | "Use my location" on the register form |
| `web/js/pages/landing.js`, `web/index.html` | FAQ from `help_articles` (public), footer contact from `support_channels()` |
| `web/css/components.css` | `.faq` styles inside the apps, `.contact-links` |
| `supabase/tests/security_test.sql` | T63 a–o (263 checks) |
| `supabase/tests/local_postgres_stub.sql` | test-only: `service_role` gets BYPASSRLS + default table grants, as on Supabase |
| `tests/unit.test.js`, `tests/pages.test.js` | notify helpers; 7 new page tests |
| `docs/runbook.md` | Messages to customers, Support tickets & Help, Map pin, **Backups and monitoring**, troubleshooting rows |
| `docs/deployment.md` | §7 Customer messages (providers, secrets, scheduler); "Before real customers" |
| `docs/api.md`, `docs/roles.md`, `docs/testing.md`, `docs/build-roadmap.md`, `docs/adr/README.md` | new functions / Edge Function, permissions, counts, batch 9 ✅ |
| `CLAUDE.md`, `AGENTS.md`, `README.md` | rule 20: messages are queued, never sent from the app; roadmap line |
