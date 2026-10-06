# Runbook

## Where to sign in
* Restaurants: `/restaurant/login.html` (also "Partner login" on the home page)
* Admins: `/admin/login.html`
* Delivery staff: `/delivery/login.html`

## Bootstrap the first admin (no SQL needed)
1. Open `/admin/login.html` → **First time here? Set up the first admin.**
2. Fill in name, email, password. If email confirmation is on, confirm the email, then sign in on the same page.
3. The first sign-in on the admin page becomes the admin automatically. This works only while there is no admin at all (`claim_first_admin()`, migration 005); afterwards the link does nothing.
4. Fill in Admin → **Settings** (company name, address, GSTIN, FSSAI) so invoices are correct.

Fallback if you ever lock yourself out: Supabase → SQL editor →
`update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'you@example.com');`

## Add another admin or a delivery person
Admin → **Team** → *Invite a team member*: email, name, role → **Send invite**.
They get an email link, choose a password on `reset.html`, and sign in at their role's login page.
Behind the scenes this calls the `invite-staff` Edge Function (`supabase/functions/invite-staff/`), which
checks the caller is an admin, sends the invite with the service-role key, and sets the role.

Requirements: the Edge Function must be deployed (`supabase functions deploy invite-staff`, already done
for this project), and your site URL (e.g. `http://localhost:3000/**`) must be in Supabase →
Authentication → URL configuration → Redirect URLs, or the emailed link will not land on `reset.html`.
Supabase's built-in mailer allows only a few emails per hour on the free tier; set up custom SMTP before launch.

## Approve a restaurant
Admin → **Customers** → *Approve*. Until then they can browse but not order.

## Deactivate someone
Admin → Team → untick *Active* → Save. They lose all access immediately.

## Change prices / photos / GST
Admin → Products. Clicking the stock or listed badge toggles it instantly. Past orders keep their original prices.

## Warehouse: receive, count, write off
Admin → **Inventory**.
* **Receive stock** when goods arrive: pick the supplier, add lines with quantity and unit cost. Stock goes up and the catalogue updates immediately.
* **Adjust** a product after a physical count (reason: count correction), to write off spoilage (wastage), or to accept a return.
* **History** shows every movement for a product; **Ledger** shows the warehouse-wide feed.
* The low-stock banner lists products at or below their alert level (set per product under Products → Edit).

## Collect payment
Admin → Orders → open an order → **Mark paid**. Customers shows the total each restaurant still owes on credit.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Blank page, console says modules blocked | Opened via `file://`. Use `npm start`. |
| "Invalid login credentials" | Wrong password, or email not confirmed. |
| Reset link goes to the wrong place | Fix *Site URL / Redirect URLs* in Supabase. |
| User signs in but is bounced to login | Account deactivated (`is_active = false`). |
| Restaurant cannot order | Status is `pending`/`suspended`, or no delivery address saved. |
| Dispatch fails | No driver assigned to the order. |
| Everything fails after weeks idle | Free project paused — resume it in the dashboard. |
