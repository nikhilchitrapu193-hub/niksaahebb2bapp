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
4. Receive stock into the new warehouse (Inventory → pick the warehouse → Receive stock, or Procurement → Receipts).
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

## When a customer cannot sign in (the confirmation email never came)
Every new customer must confirm their email once before signing in. The built-in Supabase mailer is slow, rate-limited
and often lands in spam, so the app has backups at every step:
* **Customer side:** after registering, and on the sign-in page when it says "email not confirmed", a **Resend the
  confirmation email** button sends it again (a few per hour per address). The text tells them to check spam and call us.
* **Staff side:** Admin → **Customers** shows each customer's email and *confirmed / not confirmed*; a banner counts
  those who cannot sign in. Click **Access** (needs `customers: approve`) and pick the lightest fix that works:
  1. **Resend confirmation** — ask them to check spam.
  2. **Confirm email** — you have them on the phone and the address is right; they sign in at once with their password.
  3. **Password link** — a one-time link (valid about an hour) that confirms the email and lets them choose a password;
     **Send on WhatsApp** opens a message to the number on file, or copy it. Use when they forgot the password too.
  4. **Temporary password** — set one and tell them by phone; they can change it later with *Forgot password*.
  Each action is written to the Audit log (who, which customer, which action — never the link or password).
* **Approval is separate.** Confirm gets them signing in; **Approve** on the Customers list lets them order. Do both.
* **Fix the cause:** set a custom SMTP sender in Supabase (Authentication → SMTP; Resend or Brevo have free tiers) —
  or switch *Confirm email* off under Authentication → Providers → Email, since approval is already the gate. Steps in
  `docs/deployment.md`.

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

## Buying: rate cards, buying list, purchase orders (Procurement)
Admin → **Procurement** (needs `procurement:view`; the `procurement_buyer` role has it).
1. **Rate cards** once per supplier: for each product they supply, price, MOQ, lead days, valid-to date, and tick
   *Preferred* on the supplier you normally buy from (one per product). Suppliers themselves are added under
   Inventory → Suppliers (name, phone — the phone is what "Share on WhatsApp" uses).
2. **Buying list** every afternoon: pick the warehouse and tomorrow's date. Per product you see the demand on
   open orders, free stock, what is already on order, the alert level and a suggested quantity
   (demand × days of cover + alert level − free stock − on order, rounded up to the MOQ). Raise *Days of cover*
   to buy for more than one day. Tick the rows, adjust the quantities, **Create purchase orders** → one draft
   per supplier (products without a preferred supplier ask you to choose one).
3. **Purchase orders**: open a draft, check the lines (costs come from the rate card unless you typed one),
   **Edit** if needed, then **Approve & send** (needs `procurement:approve`). **Print / PDF** gives the supplier
   a copy; **Share on WhatsApp** opens a message with the lines. A PO can be **Cancelled** until something is
   received, and **Closed short** when the supplier will not deliver the rest.
4. **Receive goods** when the truck arrives (needs `inventory:edit`): open the PO → Receive goods. Each line
   is pre-filled with the outstanding quantity; type what you accepted and what you rejected (a reason is
   required for rejections), the grade and the actual unit cost if it differs. Accepted stock goes into the
   warehouse at once; the PO becomes *part received* or *closed* by itself. Every receipt gets a GRN number.
5. **Mandi cash purchase** (Procurement → Receipts → Mandi cash purchase): the lines you bought, the bill
   amount, *Paid in cash*, a photo of the bill from the phone camera. No PO needed.
6. **Receipts** lists every GRN with its quality check; **Export CSV** gives one row per line.

## Warehouse: receive, count, write off
Admin → **Inventory**. With several warehouses, pick one in the dropdown (totals are read-only).
* **Receive stock** when goods arrive without a purchase order: it opens the same goods-receipt form as Procurement (warehouse, supplier, lines with accepted / rejected / unit cost) and writes a GRN. Stock goes up and the catalogue updates immediately. Deliveries against a PO are received from the PO itself (above).
* **Adjust** a product after a physical count (reason: count correction), to write off spoilage (wastage), or to accept a return. This sets that warehouse's count.
* **History** shows every movement for a product; **Ledger** shows the warehouse's feed.
* **Export CSV** downloads the list you are looking at.
* The low-stock banner lists products at or below their alert level (set per product under Products → Edit).

## Fulfilment: pick, trip, deliver (Fulfilment)
Admin → **Fulfilment** (needs `fulfilment:view`; the `dispatcher` role has it).
1. **Pick list**: pick a warehouse and the delivery day. You get the quantity to pick per product across that
   day's confirmed orders, plus a **Expiring soon** panel — **Write off expired** posts the wastage in one click
   (needs `inventory:edit`). Receiving with an expiry date (Procurement / Inventory → Receive) is what fills this.
2. **Trips**: **New trip** → pick the day, slot, driver and vehicle, tick the confirmed/packed orders, create.
   Open a draft and **Dispatch**: every packed order goes out for delivery under that driver, each with a 4-digit
   delivery code. **Close** the trip once everything is delivered. (Vehicles are added from the trip form's list;
   manage them in the database or a later screen.)
3. **Driver cash**: for each driver, COD cash collected vs settled. **Settle** records cash handed back
   (needs `fulfilment:approve` or `payments:edit`).
4. **Delivery charges**: a fee per city / slot with a free-above threshold; the most specific active rule wins,
   and with no rule an order falls back to the sector's minimum-order fee.

## The driver's app (delivery)
The driver sees the orders on their trip. **Start delivery** (if not already dispatched), then **Complete
delivery**: snap a photo, enter the customer's delivery code, note anything refused at the door (it goes back to
stock and the bill drops), and mark delivered. A COD order shows the cash to collect.

## Delivery slots (Settings → Delivery slots)
Set a **cut-off hour** (when a slot stops taking orders) and an optional **capacity** per city and slot. No row =
always open and uncapped. Express closes at the cut-off the same day; scheduled slots close a next-day order at
the cut-off the day before.

## Edit, cancel, order for a customer, issues
* A customer can **edit** or **cancel** their own placed order within the sector's **edit window** (Settings →
  Sectors & terms → *Edit window (min)*; default 15, 0 = none). The customer sees "X minutes left" on the order; when
  the window has passed the buttons go and the detail says "Call us to make changes." Staff can edit until the order is
  packed and cancel any order that is not delivered — the window is only for self-service.
* **New order for a customer** (Orders → the button) places an order on someone's behalf (`orders:edit`); it may
  go in past the cut-off.
* A customer **reports an issue** on a delivered order. Admin → Orders → **Issues & credits**: resolve it and,
  if due, raise a **credit note** (applied to the balance in the payments batch).

## Launch switches (Settings → Launch)
Three switches decide who can order and how much of the app the team sees (`docs/modules/launch-control.md`):
* **Live sectors** — one switch per customer type. Off = no sign-up, no orders; their customers see "not taking orders
  yet". The table shows customers, approvals and orders in 30 days per sector, so you can see when one is ready.
* **Pricing: Simple / Advanced.** Simple = type each price on the product form (the Pricing menu is hidden).
* **Stock: Simple / Counted.** Simple = a product is in stock or out of stock (the toggle on Products); no quantities,
  no reservations; Inventory and Procurement are hidden.
First launch: army cantonments on, the rest off, Simple + Simple. Saving the modes reloads the page.

## Money: receipts, credit, statements (Payments)
* **Receivables** (Payments): every customer with money open or on account, aged current / 1–30 / 31–60 / 61–90 / 90+
  days past due. An invoice is a *delivered* order; it falls due after the customer's credit days (cash on delivery:
  the delivery day). Open a customer to see open invoices, credit on account and recent receipts.
* **Record receipt** (`payments:edit`): amount, method (cash / UPI / bank / cheque / other — UPI, bank and cheque need
  the UTR or cheque number), date. Tick invoices to apply by hand; tick nothing and it applies oldest-due-first to
  pay-later invoices (the preview under the amount shows which). Also from Orders → a delivered order → **Record payment**.
* **Cash on delivery** needs nothing from you: when the order is delivered (driver's app or the Orders screen) the
  cash is booked to the driver and the receipt is written automatically (`RCT-…`, method cash, in the driver's name).
  The cash itself is settled under Fulfilment → Driver cash. If the driver collected nothing (a prepaid customer),
  **void** that receipt — the invoice reopens — then **Apply** the credit on account to it (Open the customer → On
  account → Apply).
* **Void** a receipt (`payments:approve`) with a reason: its invoices reopen; nothing is deleted.
* **Debit note**: an extra charge (crate not returned, late fee) — an open item like an invoice.
* **Credit notes** (Orders → Issues & credits) apply themselves to the customer's oldest pay-later invoice.
* **Credit limit and days**: per sector (Settings → Sectors & terms) with a per-customer override (Customers → Terms).
  A pay-later order is refused while an invoice is overdue (if the sector's *Block credit when overdue* is ticked) or when
  it would take the account over the limit; the customer's cart says why and offers cash on delivery instead.
* **Statement**: open a customer → **Statement** (printable, any date range). Customers print their own under Payments.
* **Online payments** (Razorpay): off until the keys are set — `docs/modules/payments.md`.

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
| "Invalid login credentials" | Wrong password. |
| "Your email is not confirmed yet" | The confirmation email was not used: the customer resends it from that page, or staff open Customers → **Access** (confirm, link or temporary password). |
| Access says "The email service is rate-limited" | Supabase's built-in mailer allows a few emails an hour. Use Confirm email or Password link now; set up custom SMTP for good. |
| Reset link goes to the wrong place | Fix *Site URL / Redirect URLs* in Supabase. |
| User signs in but is bounced to login | Account deactivated (`is_active = false`). |
| Customer cannot order | Status is `pending`/`suspended`, no delivery address, **no warehouse** (pin code not served), below the minimum order with no delivery fee, **their sector is switched off** (Settings → Launch), or — pay later only — an overdue invoice / the credit limit (Payments). |
| Order fails with "Only 0 kg available" but you do not count stock | Stock mode is *Counted* (Settings → Launch). Switch to *Simple* to sell on the in-stock flag alone, or receive stock under Inventory. |
| A module is missing from the menu | Hidden by the launch mode (Settings → Launch) or not granted to the team role (Settings → Roles). |
| "Enter the UTR / transaction or cheque number" | UPI, bank transfer and cheque receipts need a reference; cash and other do not. |
| A COD order shows unpaid after delivery | Its cash receipt was voided; record the cash under Payments → Record receipt (tick the invoice), or apply credit on account. |
| Cannot approve a customer | They have no warehouse yet: set one under Customers → Terms. |
| Team member sees "No access" | Their team role lacks `view` on that module (Settings → Roles), or the rows are outside their city / warehouse scope. |
| "Choose a warehouse" when receiving stock | The person has no warehouse scope and the city has no default warehouse; pick one in the GRN form or mark a warehouse default. |
| Buying list suggests 0 for everything | Stock already covers tomorrow's orders (orders reserve stock when placed) and no alert levels are set. Set a low-stock alert level per product (Products → Edit) or raise *Days of cover*. |
| "Another supplier is already preferred for that product" | Only one supplier can be preferred per product; untick it on the other supplier's rate card first. |
| "Purchase order is not a draft" | Only drafts can be edited; cancel it (nothing received) or close it short and raise a new one. |
| "A rejected quantity needs a reason" | Type why in the *Reject reason* box on that line (bruised, short, wrong grade). |
| "A mandi purchase needs the bill amount" | Type the total on the bill; the *Paid in cash* tick and the photo are how finance reconciles it later. |
| Dispatch fails | No driver assigned to the order. |
| Everything fails after weeks idle | Free project paused — resume it in the dashboard. |
