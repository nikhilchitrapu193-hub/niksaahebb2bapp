# Module: Notifications & support

Phase 1, batch 9 in `docs/build-roadmap.md`. Shipped as migration 018
(`supabase/migrations/20261027000001_notifications_support.sql`) and the `send-notifications` Edge Function.

## What it does, in one paragraph
Customers hear from us without anyone typing a message. When an order is placed, confirmed, out for delivery, delivered
or cancelled, when a receipt is recorded, when a payment falls due tomorrow or is overdue, when support replies, and when
an account is approved, a **database trigger queues a message** (SMS and/or email, from a template per event with
optional per-sector overrides) into the `notifications` **outbox**. Nothing is sent from the browser. The
`send-notifications` Edge Function drains the outbox through **one provider interface**: SMS via **httpSMS** (your own
Android phone and SIM — zero per-message cost; `docs/dependencies-and-costs.md`) or **MSG91** (DLT-registered sender
later), email via **Resend** or **Brevo**. Until a provider is configured, messages are marked *skipped* with the reason
— logged, never lost, retryable from the log. The same batch adds **support tickets** (customer raises, staff reply /
assign / close, reply notifies the customer), a **help centre** the admin edits (articles for customers, drivers,
everyone, or the public website FAQ), **support channels** (phone / WhatsApp / email shown on the website footer, the
customer Help page and as *Call · WhatsApp* buttons on customers, orders, tickets and the driver's card), and a
**map pin** (`restaurants.lat / lng`) the customer drops at sign-up or under Account so the driver's map opens on the
gate, not a search for the address.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261027000001_notifications_support.sql` |
| Sender | `supabase/functions/send-notifications/index.ts` (providers: httpsms, msg91, resend, brevo, none) |
| Security test | `supabase/tests/security_test.sql` T63 a–o |
| Core JS | `web/js/core/notify.js` (`renderTemplate` ↔ `render_template()`, `phoneDigits` ↔ `phone_for_sms()`, `telHref`, `whatsappHref`, `mapHref`, `contactLinks`), `web/js/core/geo.js` (`currentPosition`), `config.js` (`NOTIFICATION_EVENTS`, `NOTIFICATION_STATUSES`, `TICKET_STATUSES`, `TICKET_PRIORITIES`, `HELP_AUDIENCES`), `api.js` "Notifications, support & help" |
| Admin | `web/js/pages/admin/notifications.js` (Settings → Notifications: Templates · Support channels · Message log with Retry / Check queue / Send now), `web/js/pages/admin/tickets.js` (Orders → Support tickets), `web/js/pages/admin/help-centre.js` (Settings → Help centre), contact buttons in `customers.js` / `orders.js` |
| Customer | `web/js/pages/restaurant/help.js` (Help: contact buttons, tickets, FAQ), `account.js` (map pin), `orders.js` (link to Help), `login.js` + `auth.js` (map pin at sign-up) |
| Driver | `web/js/pages/delivery/main.js` (map pin link via `delivery_pins()`, WhatsApp button) |
| Website | `web/index.html` + `web/js/pages/landing.js` (FAQ from `help_articles` audience *public*; footer contact from `support_channels()`) |
| Tests | `tests/unit.test.js` (notify helpers), `tests/pages.test.js` (templates + preview, channels, log + send now, tickets both sides, help centre, landing FAQ, map pin + driver link) |
| Decision records | ADR 0022 (stay with no framework for Phase 2), ADR 0023 (outbox + provider interface, no phone-OTP login) |

## Tables and functions
| Object | Purpose |
|---|---|
| `company_settings.support_phone / support_whatsapp / support_email / sms_from_label / notify_customers` | The channels we publish, the `{company}` label, the master switch. |
| `notification_settings` | One row per event (`sector_code` NULL = default) and optional per-sector overrides: `sms_enabled`, `email_enabled`, `sms_template`, `email_subject`, `email_template`. Seeded with ten defaults. |
| `notifications` | The outbox / log: event, channel, recipient, rendered body, status `queued → sending → sent / failed / skipped`, provider + reference, error, `dedupe_key`, attempts. |
| `render_template(template, values)` | `{name}` → value; unknown names stay visible. Mirrored by `renderTemplate()` in JS (shared test values). |
| `phone_for_sms(text)` | Digits with the 91 country code or NULL (no number → no SMS row). |
| `queue_notification(event, restaurant, values, order, payment, ticket, dedupe_key, dedupe_days)` | Internal. Honours `notify_customers`, picks the sector override else the default, skips when neither channel is on, dedupes by key within N days, inserts one row per enabled channel. |
| Triggers `orders_notify`, `payments_notify`, `restaurants_notify_approved`, `reply_ticket()` | Queue order status / receipt / approval / support-reply messages. Order placed fires when the total first becomes > 0 (so the message carries the real total). |
| `queue_payment_reminders()` *(service role)* | Credit orders with a balance: `payment_due` when due tomorrow (once per order, 30-day dedupe), `payment_overdue` when past due (at most every 7 days). |
| `claim_notifications(limit)` / `mark_notification(id, status, provider, ref, error)` *(service role)* | The sender's two calls: take a batch (`for update skip locked`, status → sending, attempts + 1), then report each result. |
| `retry_notification(id)` | Staff (`settings:edit` or `orders:edit`): a failed / skipped row goes back to queued. |
| `support_tickets`, `ticket_messages` | `TKT-1000…`, status `open / waiting_customer / resolved / closed`, priority `low / normal / high`, `assigned_to`. |
| `open_ticket(subject, body, order, restaurant, priority)` | Customer (own account) or staff with `orders:edit` on a customer's behalf. Returns `{id, ticket_number}`. |
| `reply_ticket(ticket, body)` | Customer → status *open*; staff → *waiting_customer*, assigns the replier if unassigned, queues `ticket_reply`. |
| `set_ticket(ticket, status, assigned_to, priority)` | Staff. A customer may only close their own ticket. |
| `help_articles` | `slug`, `title`, `body` (plain text, blank line = paragraph), `audience` (`public` also feeds the website FAQ; `customer`, `driver`, `all`), `sort_order`, `is_published`. Anon reads published public ones; `settings:edit` writes. |
| `restaurants.lat / lng`, `update_my_location(lat, lng)`, `delivery_pins()` | The customer's map pin (sign-up metadata or Account); the driver's pins for their own active deliveries only. |
| `support_channels()` | `{phone, whatsapp, email, name}` for anon and signed-in users, without exposing the settings row. |

## Who may do what
| Action | Who |
|---|---|
| Read the message log | The customer (own rows), `settings:view` (all), `orders:view` / `customers:view` (customers in scope) |
| Edit templates, support channels, help articles | `settings:edit` |
| Retry a message, "Send now", "Check queue" | `settings:edit` (Send now also needs it inside the Edge Function); Retry also `orders:edit` |
| Raise / reply / close own ticket | The customer |
| See tickets, reply, assign, set status / priority, open on behalf | `orders:view` to see; `orders:edit` to act (scoped by city / warehouse) |
| Drop / clear a map pin | The customer (own restaurant); staff edit `lat / lng` through Customers (`customers:edit`) |

## How a message travels
1. An order's status changes (or a receipt lands, or support replies).
2. The trigger calls `queue_notification`: finds the sector's template (or the default), renders SMS and email, inserts one `notifications` row per enabled channel (`queued`).
3. The scheduler calls `send-notifications` every 5 minutes with `x-cron-secret` (or an admin presses **Send now**): it runs `queue_payment_reminders()`, claims up to 50 rows, sends each through the provider named by `SMS_PROVIDER` / `EMAIL_PROVIDER`, and marks each `sent`, `failed` (provider said no) or `skipped` (no provider configured).
4. Staff see every row under Settings → Notifications → Message log; the customer sees their own under nothing yet (the log is a staff tool; the customer gets the message itself).

## Setting up sending (one-time, `docs/deployment.md` §7)
* **SMS, free:** install httpSMS on an Android phone with a company SIM, create an API key, set secrets `SMS_PROVIDER=httpsms`, `HTTPSMS_API_KEY`, `HTTPSMS_FROM=+91…`. Carrier limits apply (~100–200 SMS/day per SIM is a safe ceiling; DND numbers may still receive transactional texts, but the sender is a normal number, not a brand id).
* **SMS, scale:** DLT-register a 6-character sender id and the templates, then `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_SENDER`, `MSG91_TEMPLATE_ID`.
* **Email:** verify your domain at Resend or Brevo, then `EMAIL_PROVIDER=resend|brevo`, `RESEND_API_KEY` / `BREVO_API_KEY`, `EMAIL_FROM="Fresh Supply <orders@yourdomain.in>"`. (Supabase Auth's own emails — confirmation, reset — use the SMTP settings in the Supabase dashboard; the same Resend / Brevo account provides those credentials.)
* **Scheduler:** anything that can POST a URL every 5 minutes with a header (cron-job.org free tier, GitHub Actions schedule, or Supabase `pg_cron` + `pg_net`) → `POST https://<project>.supabase.co/functions/v1/send-notifications` with `Authorization: Bearer <anon key>` and `x-cron-secret: <CRON_SECRET>`.

## What this batch does not do (on purpose)
* No phone-OTP sign-in (ADR 0023): email + password + the customer-access backups cover Phase 1; a SIM gateway is not reliable enough for the login path.
* No WhatsApp Business API messages: the *WhatsApp* buttons open a chat (wa.me) for a person to type; automated WhatsApp needs a Meta-approved business account and templates (Phase 2 growth batch can add it as one more provider in the same interface).
* No customer-facing message log: customers get the SMS / email itself.
