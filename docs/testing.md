# Testing

```bash
npm test
```

| Suite | File | What it proves |
|---|---|---|
| Unit | `tests/unit.test.js` | HTML escaping, INR formatting, cart maths, order preview (MOV / fee), CSV export and parsing, permissions, audit wording, **the pricing formula** (same numbers as SQL T30), rule picker, GST display, category tree, catalogue filters, variant grouping, CSV product import, price-list arithmetic, **the buying-list arithmetic** (same numbers as SQL T45), MOQ rounding, PO totals and message, **launch rules** (hidden modules, banner), **oldest-due-first allocation preview** and ageing buckets, **customer edit window** (canCustomerChange, minutesLeftToChange) |
| Page smoke | `tests/pages.test.js` | Each screen renders against a fake backend and calls the right functions (incl. locations, sectors, roles, audit, customer terms, per-warehouse GRN, PO / fee in the cart, pin-code check, all sectors on sign-up, price board, rules, benchmarks, product HSN / pack size, catalogue benchmark label, invoice HSN, catalogue filters / packs / your price, product page, product details, CSV upload, price lists, packed quantities, inherited rules, buying list → draft POs, PO approve and receive, mandi purchase, rate cards, inventory receive via GRN, pick list + expiry write-off, trip build + dispatch, driver cash settle, delivery charges, delivery completion with OTP + returns, order edit, report issue → credit note, order-on-behalf, Launch screen, lite menu + simple product form, sector-off banner + credit disabled in the cart, live sectors on sign-up, credit limit on sectors / customers, receivables + record receipt, receipts + void, record payment from a delivered order, customer Payments page, statement page, payments no-access, resend confirmation on the login page, Customers → Access, customer edit window) |
| Static | `tests/static.test.js` | No broken script/CSS/import paths; no secret keys shipped |
| Database security | `supabase/tests/security_test.sql` | 248 role / RLS / inventory / state-machine / permission / scope / audit / pricing / catalogue / procurement / fulfilment / orders+ / launch / payments checks (run in the SQL editor; it rolls back and leaves no data) |

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
