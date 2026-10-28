# Testing

```bash
npm test
```

| Suite | File | What it proves |
|---|---|---|
| Unit | `tests/unit.test.js` | HTML escaping, INR formatting, cart maths, order preview (MOV / fee), CSV export and parsing, permissions, audit wording, **the pricing formula** (same numbers as SQL T30), rule picker, GST display, category tree, catalogue filters, variant grouping, CSV product import, price-list arithmetic, **the buying-list arithmetic** (same numbers as SQL T45), MOQ rounding, PO totals and message, **launch rules** (hidden modules, banner), **oldest-due-first allocation preview** and ageing buckets, **customer edit window** (canCustomerChange, minutesLeftToChange) |
| Page smoke | `tests/pages.test.js` | Each screen renders against a fake backend and calls the right functions (incl. locations, sectors, roles, audit, customer terms, per-warehouse GRN, PO / fee in the cart, pin-code check, all sectors on sign-up, price board, rules, benchmarks, product HSN / pack size, catalogue benchmark label, invoice HSN, catalogue filters / packs / your price, product page, product details, CSV upload, price lists, packed quantities, inherited rules, buying list → draft POs, PO approve and receive, mandi purchase, rate cards, inventory receive via GRN, pick list + expiry write-off, trip build + dispatch, driver cash settle, delivery charges, delivery completion with OTP + returns, order edit, report issue → credit note, order-on-behalf, Launch screen, lite menu + simple product form, sector-off banner + credit disabled in the cart, live sectors on sign-up, credit limit on sectors / customers, receivables + record receipt, receipts + void, record payment from a delivered order, customer Payments page, statement page, payments no-access, resend confirmation on the login page, Customers → Access, customer edit window) |
| Static | `tests/static.test.js` | No broken script/CSS/import paths; no secret keys shipped |
| Database security | `supabase/tests/security_test.sql` | 293 role / RLS / inventory / state-machine / permission / scope / audit / pricing / catalogue / procurement / fulfilment / orders+ / launch / payments / notifications & support / reports / customer organisation checks (run in the SQL editor; it rolls back and leaves no data) |

The fake backend lives in `tests/helpers/fake-supabase.js`. These tests do **not** replace trying the
real app in a browser.

### Running the SQL test on a local Postgres (optional)
The SQL test also runs on a plain Postgres 16 if you first create the parts of Supabase it touches
(roles `anon` / `authenticated` / `service_role`, `auth.users`, `auth.uid()`, `storage.buckets` / `storage.objects`, and
default privileges for new tables): run `supabase/tests/local_postgres_stub.sql` first, then the migrations,
the seed and the test, as its header shows. The Supabase SQL editor needs none of this.

### Two copies of one formula
`compute_price_from()` (SQL) and `computePrice()` (`web/js/core/pricing.js`) must give the same numbers.
`security_test.sql` T30a–e and the `computePrice` tests in `tests/unit.test.js` use the **same inputs**;
when you change the formula, change both and both tests (docs/code-rules.md rule 8). The same holds for
`buying_list()` ↔ `suggestedBuy()` (`web/js/core/procurement.js`): T45c–d and the `suggestedBuy` unit test share their numbers. `allocate_customer_credits()` ↔ `fifoAllocate()`
(`web/js/core/receivables.js`) follow the same oldest-due-first rule (T58c–d, the `fifoAllocate` unit test).

## Adding a test
* New helper → `tests/unit.test.js`.
* New screen → a case in `tests/pages.test.js` using `setup({ session, profile, tables, rpc })`.
* New database rule → a numbered check in `security_test.sql`.

## Notifications & support (migration 018)
T63 a–o: placing / delivering an order and recording a receipt queue messages; `queue_payment_reminders()` queues an
overdue reminder once (second run deduped); the sender claims a batch (status sending, attempts 1) and marks one sent;
`claim_notifications` is service-role only; a customer opens a ticket, a staff reply sets waiting_customer + assigns +
notifies, another customer neither sees nor replies, the customer may close but not reopen; the website reads public
help articles only, a picker cannot edit them; the customer drops a map pin and an impossible one is refused;
`render_template` leaves unknown placeholders visible. The JS twin (`renderTemplate`, `phoneDigits`) is checked in
`tests/unit.test.js` with the same strings; `tests/pages.test.js` covers Settings → Notifications (template edit with
preview, support channels, log + Retry + Send now), Orders → Tickets (reply + update), Settings → Help centre, the
website FAQ / footer, the customer Help page and the Account map pin + the driver's pin link.
Local stub note: `supabase/tests/local_postgres_stub.sql` gives `service_role` BYPASSRLS and default table grants, as
Supabase does, so the sender's direct reads behave as in production.

## Reports & dashboard (migration 019)
T64 a–o: `sales_report` by day / product / sector (sector totals equal the non-cancelled order total), a reversed range
is refused, `receivables_trend` returns one row per week with open ≥ overdue, the dashboard narrows to a city and
carries 14 days + open tickets, a city manager's report never shows the other city, a picker cannot run reports;
documents: the customer records their own FSSAI path, a path outside their folder is refused, the storage policy lets
them upload into their own folder only, another customer cannot see the object while staff can; content pages: the
website reads the four published pages, a picker cannot edit them, `support_channels()` carries the SEO title.
`tests/unit.test.js` checks `reportTotals` / `reportColumns` / `barHeights` and `renderBody`; `tests/pages.test.js`
covers the Reports screen (totals, regroup, city filter, CSV name, trend), the picker's missing menu, the dashboard
filter + chart, Settings → Website, `page.html` + footer, and the Account document upload.
Local stub note: `local_postgres_stub.sql` now has `storage.foldername()` and grants on `storage.objects`, as Supabase does.

## Customer organisation (migration 020)
T65 a–o: every account has a primary outlet mirroring its address and the two stay in sync both ways; invited members
join the account (owner + manager + approver, no new account); the owner adds an outlet (warehouse from its pin code)
and `my_order_terms` lists both; a member resolves to the account with role and outlet scope; an outlet manager's order
carries the outlet address and is held; they cannot order for another outlet, see only their outlet's orders and
cannot approve; staff cannot confirm a held order; an approver's own order is not held; approve keeps it placed and
staff then confirm; the owner's rejection cancels it and returns stock; another customer sees no outlets / members while
staff list them. `tests/pages.test.js` covers the cart outlet picker (+ slot, `p_outlet_id`, Approvals badge), the
Approvals tab, the outlet manager's limits, Team invite + outlet save, the admin filter and held notice, the login
sector preselect and the landing tiles.
