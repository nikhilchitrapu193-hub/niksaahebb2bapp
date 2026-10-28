# 0020 — A sign-up never dead-ends on an email: self-service resend plus staff-side backups
**Status:** Accepted

**Context.** The first army-cantonment sign-up on the live project never received its confirmation email (Supabase's
built-in mailer sends from `noreply@mail.app.supabase.io`, is best-effort, rate-limited to a few messages an hour, and
lands in spam often). The customer could not sign in, the login page offered no way out, and the admin could neither see
the problem nor fix it. The owner's requirement: the app must have a backup for every such step and never get stuck.

**Decision.**
1. **Self-service first.** The login page keeps the address typed last; after registering, and whenever sign-in fails
   with "email not confirmed", a *Resend the confirmation email* button calls `auth.resend` (public, rate-limited by
   Supabase per address). The text says to check spam and to call us.
2. **Staff can always finish it.** The Customers screen shows each customer's email and whether it is confirmed
   (`admin_customer_logins()`, customers:view, in scope) and flags the ones who cannot sign in. *Access* (customers:
   approve) offers four backups through the `customer-access` Edge Function, in rising order of force: resend the
   email · confirm the email now · a one-time password link to pass on by WhatsApp or phone · a temporary password told
   over the phone. Every action writes an `audit_log` row naming the staff member, the customer and the action (never the
   link or the password).
3. **Approval and confirmation stay separate.** Approval (`set_customer_status`) is the business decision; confirmation
   is proof of the address. Approving an unconfirmed customer is allowed and the screen says they still cannot sign in.
   Both are needed to order; either can be done first.
4. **Service role stays server-side.** Confirming an email, generating a link and setting a password need the service
   key, so they live in the Edge Function, which re-checks the caller's role, permission and scope itself — the same
   pattern as `invite-staff` (ADR 0002).
5. **The mailer is the real fix; the backups are the safety net.** Deployment docs now put a custom SMTP sender
   (Resend / Brevo, free tiers) on the launch checklist, and note that *Confirm email* can be switched off in Supabase
   entirely because approval is already the gate. Either way the backups stay: a typo in an address is not fixed by a
   better mailer.

**Consequences.**
+ No customer waits on an email; staff can get anyone signing in during the phone call that reports the problem.
+ Every intervention is auditable; the browser never sees a service key.
− `confirm_email` trusts the staff member's judgement that the address is the customer's; the audit row is the control.
− A password link is a bearer secret while it is valid (about an hour, one use); staff send it over the channel they
  trust (WhatsApp to the number on file is offered, copy for anything else).
