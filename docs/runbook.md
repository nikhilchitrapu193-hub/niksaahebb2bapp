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
Admin → **Team** → *Invite a team member*: email, name, app (admin / delivery), **team role** → **Send invite**.
They get an email link, choose a password on `reset.html`, and sign in at their role's login page.
Once they appear in the table, set their **city** and **warehouse** scope if they should see only one
(leave both blank for "everything"). Behind the scenes this calls the `invite-staff` Edge Function
(`supabase/functions/invite-staff/`), which checks the caller is an admin, sends the invite with the
service-role key, and sets the role and team role.

What a team role may do: Admin → **Settings → Roles & permissions** (super admin only). See [roles.md](roles.md).

## Switch on a new city
Admin → **Settings → Cities & warehouses**:
1. **Add city** (name, GST state code).
2. **Add warehouse** under it and tick *Default warehouse for this city*.
3. **Add pin code** for every area that warehouse delivers to. Customers sign up with a pin code; if it
   matches, they are served from that warehouse automatically. The public site's "Do you deliver here?"
   box answers from the same list.
4. Receive stock into the new warehouse (Inventory → pick the warehouse → Receive stock).
5. Invite a city manager and set their scope to the city.

Products are listed everywhere by default; untick a city on the product form to hide one there.

## Sectors and trading terms
Admin → **Settings → Sectors & terms**: minimum order value, delivery fee below it, credit days, whether a
PO number is required, whether orders need approval (Phase 2), and whether the sector may self-register.
Rule: below the minimum, the fee is charged; if the fee is ₹0 the order is refused.
Per-customer overrides: Customers → **Terms** (also sets sector, city, pin code and warehouse).

Requirements: the Edge Function must be deployed (`supabase functions deploy invite-staff`, already done
for this project), and your site URL (e.g. `http://localhost:3000/**`) must be in Supabase →
Authentication → URL configuration → Redirect URLs, or the emailed link will not land on `reset.html`.
Supabase's built-in mailer allows only a few emails per hour on the free tier; set up custom SMTP before launch.

## Approve a customer
Admin → **Customers** → *Approve*. Until then they can browse but not order. Approval is refused while the
customer has **no warehouse** (their pin code is not in any zone): open **Terms**, pick the warehouse (or add
their pin code under Settings → Cities & warehouses), then approve. Needs the `customers:approve` permission.

## Deactivate someone
Admin → Team → untick *Active* → Save. They lose all access immediately.

## Change prices / photos / GST
Admin → Products. Clicking the stock or listed badge toggles it instantly. Past orders keep their original prices.

## Warehouse: receive, count, write off
Admin → **Inventory**. With several warehouses, pick one in the dropdown (totals are read-only).
* **Receive stock** when goods arrive: pick the warehouse and supplier, add lines with quantity and unit cost. Stock goes up and the catalogue updates immediately.
* **Adjust** a product after a physical count (reason: count correction), to write off spoilage (wastage), or to accept a return. This sets that warehouse's count.
* **History** shows every movement for a product; **Ledger** shows the warehouse's feed.
* **Export CSV** downloads the list you are looking at.
* The low-stock banner lists products at or below their alert level (set per product under Products → Edit).

## Collect payment
Admin → Orders → open an order → **Mark paid** (needs `payments:edit`). Customers shows the total each customer still owes on credit.

## Who changed what
Admin → **Audit log**: every change to prices, orders, payments, customers, team members, permissions and
settings, with the person and the old and new values. Filter by table or person; export as CSV.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Blank page, console says modules blocked | Opened via `file://`. Use `npm start`. |
| "Invalid login credentials" | Wrong password, or email not confirmed. |
| Reset link goes to the wrong place | Fix *Site URL / Redirect URLs* in Supabase. |
| User signs in but is bounced to login | Account deactivated (`is_active = false`). |
| Customer cannot order | Status is `pending`/`suspended`, no delivery address, **no warehouse** (pin code not served), or below the minimum order with no delivery fee. |
| Cannot approve a customer | They have no warehouse yet: set one under Customers → Terms. |
| Team member sees "No access" | Their team role lacks `view` on that module (Settings → Roles), or the rows are outside their city / warehouse scope. |
| "Choose a warehouse" when receiving stock | The person has no warehouse scope and the city has no default warehouse; pick one in the GRN form or mark a warehouse default. |
| Dispatch fails | No driver assigned to the order. |
| Everything fails after weeks idle | Free project paused — resume it in the dashboard. |
