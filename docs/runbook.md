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
PO number is required, whether orders need approval (Phase 2), and whether the sector may self-register
(all five may by default since migration 008; untick a sector to take it off the public sign-up form).
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
Admin → Products for photos, HSN code, pack size (what one selling unit holds: 1 kg, 15 litre tin, tray of
30), GST, grade, origin, veg / non-veg, shelf life and storage note. Clicking the stock or listed badge
toggles it instantly. Past orders keep their original prices. A price published from the price board is
read-only here — change it on the board.

**Categories** (Products → Categories): two levels. Add "Leafy greens" under Vegetables; products can sit
at either level. A sub-category without its own pricing rule uses its parent's.

**Pack sizes**: add the 25 kg bag as its own product (own SKU, price, stock) and set *Pack size of* to the
main product with a label ("25 kg bag"). Customers see one card with a pack picker.

**Sold by weight**: tick it on leafy greens, meat, fish. Customers order in kg; after packing, open the order
(Orders → row → *Packed* column) and type the actual weight — within the tolerance you set — and *Save packed
quantities*. The order is re-totalled and the invoice shows "ordered 5, billed 5.2". Other items may only be
marked short the same way.

**Upload CSV** (Products): a file with `sku, name, category, price, unit` for new products and any other
column to update existing ones (see the dialog for the list). Prices published from the board are left alone.

## Price lists (Pricing → Price lists)
A % over or under the published price per city and / or sector (hotels −3 %), plus fixed prices for chosen
products. The most specific active list wins: city + sector, then sector, then city. Customers see "Your
price" with the published one struck through, and are charged the same at checkout.

## Prices: the morning routine (Pricing)
1. **Benchmarks** — pick the source (Rythu Bazaar board, NECC, DoCA, METRO…) and today's date, type the
   rates, *Save rates*. Or *Upload CSV* (`sku,price` and optionally `source,date,market`).
2. **Price board** — type today's supplier quote where it changed (saved when you leave the box). Every row
   shows cost basis, landed cost, markup, the suggested price, the current price, the benchmark and its age,
   margin and flags (*No cost on file*, *Below cost*, *Under minimum markup*, *Held at benchmark cap*,
   *Benchmark older than 3 days*, *Cost moved > 10 %*). Edit a suggested price if you must.
3. Tick the rows (or *Select all shown*), **Publish**, give a reason. Pick *At a set time…* to prepare
   tomorrow's prices today: they go live by themselves (every 5 minutes where pg_cron is on, and whenever
   someone opens the board). A pending change is shown at the top and can be cancelled.
4. Below cost or under the minimum markup the publish asks for *Publish anyway*; a category whose rule
   says *block* refuses outright.

The *…* button on a row explains the price step by step, shows the price history chart, and holds the
product's override: how to price (cost + markup / benchmark + fixed amount / manual), where the cost comes
from, yield % (chicken ~70 %), and any variable the category rule should not apply to this product.

**Rules** — one card per category (and the global default): markup, minimum markup, wastage, transport and
handling per kg, packing per unit, market fee, rounding step, benchmark cap and source, cost method, margin
guard. *Change* saves a new rule from a chosen date and keeps the old one on record; the test box shows what
₹100 of cost would sell for. Needs `pricing:edit`; publishing needs `pricing:approve`.

Customers see the benchmark as the struck-through "market rate" with its source and date. Settings →
*Show catalogue prices including GST* switches the catalogue display; invoices always show the split.

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
| Price board shows "No cost on file" for everything | No receipts with a unit cost yet: type supplier quotes on the board, or receive stock with costs under Inventory. |
| Scheduled price did not go live | pg_cron is not enabled on the project (Database → Extensions); opening the price board applies anything due. |
| "You do not have permission to publish prices" | The team role lacks `pricing:approve`; tick it under Settings → Roles & permissions. |
| "Packed … is more than 10 % away from the ordered …" | The weighed quantity is outside the product's tolerance: raise it under Products → Edit, or split the difference with the customer. |
| Customer says the cart price differs from the catalogue | Both come from `my_price_list()`; reload the page — a price list changed while they were browsing. |
| "Invalid login credentials" | Wrong password, or email not confirmed. |
| Reset link goes to the wrong place | Fix *Site URL / Redirect URLs* in Supabase. |
| User signs in but is bounced to login | Account deactivated (`is_active = false`). |
| Customer cannot order | Status is `pending`/`suspended`, no delivery address, **no warehouse** (pin code not served), or below the minimum order with no delivery fee. |
| Cannot approve a customer | They have no warehouse yet: set one under Customers → Terms. |
| Team member sees "No access" | Their team role lacks `view` on that module (Settings → Roles), or the rows are outside their city / warehouse scope. |
| "Choose a warehouse" when receiving stock | The person has no warehouse scope and the city has no default warehouse; pick one in the GRN form or mark a warehouse default. |
| Dispatch fails | No driver assigned to the order. |
| Everything fails after weeks idle | Free project paused — resume it in the dashboard. |
