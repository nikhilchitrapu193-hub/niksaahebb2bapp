# Patch guide — P2-1: Customer organisation (28 Oct 2026)

First batch of Phase 2 (`docs/phase2-plan.md`). Apply **after** batches 9 and 10.

**What's new** (migration 020 — **already applied live**; Edge Function `customer-users` — **already deployed**):
* **Several outlets per customer account.** A hotel's three kitchens or a cantonment's messes share one account
  (terms, credit line, balance, statement) but each outlet has its own address, pin code (→ warehouse), phone, usual
  slot and map pin. Account → **Outlets** for the customer; Customers → **Account** for staff. The cart asks which outlet
  the order is for; the order, the pick list and the driver follow the outlet. Every existing account got one
  *primary* outlet from its address — nothing changes for them until they add another.
* **Members.** Besides the owner, an account can have **approvers** (see every outlet, sign off orders, may order) and
  **outlet managers** (order for one outlet or all). The owner invites them by email from Account → **Team**; they set
  a password and sign in on the normal customer login. Staff can invite / disable members too.
* **Approval before dispatch.** Where the sector needs it (army cantonments, institutions — Settings → Sectors) or the
  account is set to (Customers → Terms), an order placed by an *outlet manager* is **held**: the kitchen sees
  *Awaiting approval* on Orders and cannot confirm it until an owner / approver approves it from the new **Approvals**
  tab in the customer app. Rejecting cancels it and returns the stock. Orders by owners, approvers or staff are never
  held — a one-person account works exactly as before, even in those sectors.
* **Sector home pages.** Five pages (`page.html?slug=sector-<code>`, editable under Settings → Website) and a
  **"Who we serve"** strip on the home page; each *Register* button pre-selects the sector on the sign-up form.
* ADR 0025 records the model (account = commercial unit; outlets and members hang off it; approval is an order flag).

Tested: `npm test` **147/147** · `security_test.sql` **293/293** (15 new T65 checks) on a clean local Postgres ·
12 screens rendered in headless Chromium with no console errors (Approvals, Account with Outlets + Team, outlet form,
invite form, cart with outlet picker, held order detail, admin Orders with filter and held notice, Customers → Account,
home page strip, sector page, register with the sector pre-selected).

**Live project (bzxygscjhvcwahwqgqin):** migration 020 applied — 1 account → 1 primary outlet, 1 owner member row,
0 orders without an outlet, 5 sector pages; `customer-users` deployed (version 1).

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)
1. Batches 9 and 10 first. Unzip `fresh-supply-p2-1-customer-organisation.zip` into the repo root — **32 files (7 new,
   25 modified)**. Say **yes** to replacing.
2. `npm test` → `# pass 147`.
3. `git add -A` → `git commit -m "P2-1: customer organisation — outlets, members, approval before dispatch (020)"` → `git push origin main`.
4. Database / functions: **nothing to run** — 020 is live and `customer-users` is deployed.
5. Try it as a customer: Account → Outlets → *Add an outlet*; Account → Team → *Invite a member* (role *Outlet manager*,
   that outlet). Sign in as them, place an order — if the sector needs approval it shows *Awaiting approval*; back as the
   owner, Approvals → Approve. In the admin, Orders shows the badge and the filter.
6. Read the five sector pages under Settings → Website and adjust the wording to your offer.

## Files — NEW (7)
| Path | What it is |
|---|---|
| `supabase/migrations/20261028000001_customer_organisation.sql` | migration 020 (applied live) |
| `supabase/functions/customer-users/index.ts` | invite a member (deployed) |
| `web/js/pages/restaurant/organisation.js` | Account → Outlets · Team |
| `web/js/pages/restaurant/approvals.js` | Approvals tab |
| `docs/modules/customer-organisation.md` | module doc |
| `docs/adr/0025-customer-organisation.md` | decision record |
| `docs/patches/2026-10-28-customer-organisation-batch.md` | this guide |

## Files — MODIFIED (25)
| Path | What changed |
|---|---|
| `web/js/core/config.js` | `CUSTOMER_ROLES`, `APPROVAL_STATUSES` |
| `web/js/core/api.js` | `placeOrder` / `placeOrderFor` take `outletId`; `listOrders({approvalStatus})`; orders embed `outlets(name)`; `saveCustomerTerms` sends the approval override; "Customer organisation" section (`listOutlets`, `saveOutlet`, `listMyCustomerUsers`, `listCustomerUsersOf`, `setCustomerUser`, `inviteCustomerUser`, `approveOrder`) |
| `web/js/core/auth.js` | `loadCurrentUser` resolves the account through `my_restaurant_id()` (members) |
| `web/js/pages/restaurant/main.js` | Approvals tab (+ badge, hidden when the account never holds orders), outlet picker + held notice in the cart, "sent for approval" toast |
| `web/js/pages/restaurant/account.js` | Outlets + Team sections; business details read-only for members |
| `web/js/pages/restaurant/orders.js` | `approvalBadge`, outlet name, approve / reject on a held order |
| `web/js/pages/admin/orders.js` | approval filter, badge, notice, outlet name; outlet picker on "New order for a customer" |
| `web/js/pages/admin/customers.js` | **Account** button (outlets + members, add / invite / disable); Terms: approval before dispatch |
| `web/js/pages/login.js` | `#register&sector=<code>` pre-selects the sector |
| `web/js/pages/landing.js`, `web/index.html` | "Who we serve" strip |
| `web/js/pages/page.js` | sector pages end with Register / Partner login |
| `web/css/components.css` | hidden nav link |
| `supabase/tests/security_test.sql` | T65 a–o (293 checks); T64m relaxed to "published pages only" |
| `tests/pages.test.js` | 7 new tests |
| `docs/runbook.md` | Outlets, members and approvals; troubleshooting rows |
| `docs/api.md`, `docs/roles.md`, `docs/testing.md`, `docs/deployment.md`, `docs/build-roadmap.md` (Phase 2 table), `docs/adr/README.md`, `README.md` | functions, Edge Function, customer-side roles, counts, P2-1 ✅ |
| `CLAUDE.md`, `AGENTS.md` | rule 21: the account is the commercial unit; outlets and members hang off it |
