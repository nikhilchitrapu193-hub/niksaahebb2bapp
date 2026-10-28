# 0023 — Notifications are an outbox behind one provider interface; no phone-OTP login
**Status:** Accepted

**Context.** Customers need to hear when an order moves, when a payment is due and when support replies — by SMS first
(kitchens read texts, not email) and email second. The owner asked whether **httpSMS** (an open-source gateway that
sends through an Android phone's own SIM) could carry SMS and one-time passwords. India's transactional SMS otherwise
needs DLT registration (sender id, templates) and a paid aggregator (MSG91 and the like).

**Options considered.**
1. Send from the browser or from database triggers directly (HTTP from Postgres via `pg_net`).
2. An outbox table filled by triggers, drained by a server-side sender with pluggable providers.
3. A third-party notification service (Novu, Knock, Courier) between the database and the channels.

**Decision.**
1. **Outbox (option 2).** Triggers only *queue* (`notifications` rows); the `send-notifications` Edge Function sends and
   marks each row `sent / failed / skipped`. The database never makes HTTP calls, the browser never holds a provider
   key, a provider outage delays messages instead of losing them, and every message is visible with its error.
2. **One provider interface, several providers.** `send(row)` switches on `SMS_PROVIDER` / `EMAIL_PROVIDER`:
   `httpsms` (own phone + SIM, free, good for the first hundred orders a day), `msg91` (DLT, scale), `resend` / `brevo`
   (email). Adding WhatsApp Business or another SMS aggregator is one more `case` and its secrets. `none` is a valid
   setting: rows are *skipped* with the reason, so the log always explains what did not go out.
3. **Templates in the database, per event and per sector**, with `{placeholders}` rendered by `render_template()` in
   SQL and the same function in JS for the preview. The owner edits wording under Settings; a cantonment can get a
   formal "indent received" while a restaurant gets a short text.
4. **Reminders are computed, not stored as future jobs.** `queue_payment_reminders()` looks at open credit orders every
   run and dedupes by key, so a payment received five minutes before the run suppresses the reminder.
5. **No phone-OTP sign-in.** A SIM gateway can carry notifications (a late text is an annoyance) but not the login path
   (a late or lost OTP is a locked-out customer at 6 am). Email + password with the customer-access backups (ADR 0020)
   stays the login; phone-OTP returns as an option when a DLT-registered aggregator is in place and the owner wants
   it, as a separate decision.

**Consequences.**
+ Zero per-message cost at launch (httpSMS on a company phone); a switch of two secrets moves to an aggregator.
+ Complete audit of what each customer was told and when; failed messages retry from the log.
− Messages are not instant: they go out on the next scheduler run (every 5 minutes) or when an admin presses Send now.
− A phone-based gateway has limits (carrier caps, the phone must stay on and online); the runbook names them and the
  log makes a stuck phone visible (rows stay *queued*).
− Email sent from the app (orders, receipts) and email sent by Supabase Auth (confirmation, reset) are configured in
  two places; both can use the same Resend / Brevo account.
