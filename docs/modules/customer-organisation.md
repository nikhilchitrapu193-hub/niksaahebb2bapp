# Module: Customer organisation

Phase 2, batch P2-1 in `docs/build-roadmap.md` / `docs/phase2-plan.md`. Shipped as migration 020
(`supabase/migrations/20261028000001_customer_organisation.sql`) and the `customer-users` Edge Function.

## What it does, in one paragraph
A customer account (the `restaurants` row: the business, its sector, terms, credit line and balance) can now have
**several outlets** — a hotel's three kitchens, a cantonment's officers' and other-ranks' messes — each with its own
address, pin code (→ warehouse), phone, usual slot and map pin; the cart asks which outlet an order is for and the
order carries it (address, city and warehouse come from the outlet). Besides the **owner** (the sign-up login) an
account has **members**: **approvers** see every outlet and sign off orders; **outlet managers** order for their
outlet (or all). The owner invites them by email from Account → Team; the invitee sets a password and lands in the same
app with the same catalogue, prices and terms. When the sector (army cantonments, institutions) or the account needs
**approval before dispatch**, an order placed by an outlet manager is **held** — the kitchen sees it but cannot confirm
it — until an owner / approver approves it from the **Approvals** tab (or rejects it, which cancels it and returns the
stock). Orders placed by owners, approvers or staff are never held, so single-person accounts behave exactly as before.
The public site gains a **"Who we serve"** strip and one page per sector (`page.html?slug=sector-<code>`, editable under
Settings → Website) whose register button pre-selects the sector.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261028000001_customer_organisation.sql` |
| Edge Function | `supabase/functions/customer-users/index.ts` (invite a member) |
| Security test | `supabase/tests/security_test.sql` T65 a–o |
| Core JS | `config.js` (`CUSTOMER_ROLES`, `APPROVAL_STATUSES`), `api.js` (`placeOrder` / `placeOrderFor` with `outletId`, `listOrders({approvalStatus})`, "Customer organisation" section), `auth.js` (`loadCurrentUser` resolves the account through `my_restaurant_id()`) |
| Customer app | `web/js/pages/restaurant/organisation.js` (Account → Outlets · Team), `approvals.js` (Approvals tab), `account.js` (members read-only), `orders.js` (`approvalBadge`, outlet name, approve / reject on the detail), `main.js` (outlet picker in the cart, held notice, Approvals tab + badge) |
| Admin | `orders.js` (filter "Awaiting customer approval", badge, notice, outlet; outlet picker on "New order for a customer"), `customers.js` (**Account** dialog: outlets + members, invite / disable; Terms: approval override) |
| Website | `index.html` + `landing.js` ("Who we serve" tiles), `page.js` (sector page register button), `login.js` (`#register&sector=<code>` pre-selects) |
| Tests | `tests/pages.test.js` (cart outlet + slot + badge, Approvals approve, outlet manager limits, Team invite + outlet save, admin filter + held notice, login preselect, landing tiles) |
| Decision record | ADR 0025 |

## Tables and functions
| Object | Purpose |
|---|---|
| `outlets` | `restaurant_id`, `name`, `address`, `phone`, `city_id`, `pincode`, `warehouse_id`, `lat/lng`, `default_slot`, `is_primary`, `is_active`. One primary per account (created for every existing account from its address). |
| Triggers `restaurants_sync_primary_outlet` / `outlets_sync_restaurant` | The primary outlet and `restaurants.address / phone / city_id / pincode / warehouse_id / lat / lng` stay identical whichever side is edited (each side writes only when values differ, so no loop). Older screens (Customers → Terms, Account) keep working unchanged. |
| `orders.outlet_id`, `approval_status` (`not_required / pending / approved / rejected`), `approved_by`, `approved_at` | Which outlet; whether the order is held. Existing orders got the primary outlet. |
| `customer_users` | `user_id` (pk), `restaurant_id`, `role` (`owner / approver / outlet_manager`), `outlet_id` (null = all), `is_active`, `invited_by`. Every owner has a row too. |
| `restaurants.needs_order_approval` | Account override of `sectors.needs_order_approval` (null = inherit). Customers → Terms. |
| `my_restaurant_id()` *(v2)* | The owner's account, else the member's. Every policy / function keyed on it covers members. |
| `my_customer_role()`, `my_outlet_id()` | The caller's role; the outlet an outlet manager is limited to. |
| `save_outlet(id, restaurant, name, address, phone, city, pincode, lat, lng, slot, active, warehouse)` | Owner (own account) or `customers:edit` in scope. Warehouse follows the pin code (staff may pass one). The primary outlet cannot be switched off. |
| `set_customer_user(user, role, outlet, active)` | Owner or `customers:edit`: role / outlet / active. The owner row is fixed. |
| `my_customer_users()`, `customer_users_of(restaurant)` | Members with names and outlet names, for the customer and for staff. |
| `handle_new_user()` *(v4)* | Invite metadata `customer_user_of` / `customer_role` / `customer_outlet_id` → a member row instead of a new account; a normal sign-up also gets its owner row. |
| `place_order(…, p_outlet_id)` *(v7)*, `place_order_for(…, p_outlet_id)` *(v2)* | Build the "restaurant as seen from this outlet" record (`restaurant_for_outlet`) and run the unchanged order core; stamp `outlet_id`; hold the order (`approval_status = pending`) when `customer_needs_approval()` and the placer is an outlet manager. Previous versions are `*_legacy`. |
| `approve_order(order, approve, note)` | Owner / approver. Approve keeps the order placed; reject cancels it and returns stock. |
| `set_order_status()` *(v4)* | Staff cannot move a `pending` order anywhere but cancelled. |
| `my_order_terms()` *(v5)* | + `customer_role`, `outlet_scope`, `needs_order_approval`, `orders_held_for_me`, `can_approve`, `pending_approvals`, `outlets[]`. |
| `delivery_pins()` *(v2)*, `update_my_location()` *(v2)*, `update_my_restaurant()` / `update_my_delivery_area()` *(owner only)* | Pins come from the outlet; members set their own outlet's pin; only the owner edits the business. |
| Policies | `restaurants_select` + `profiles_select` + `orders_select` extended: a member reads their account, the names of fellow members, and (outlet managers) only their outlet's orders. `outlets` / `customer_users`: own account or staff in scope. |

## Who may do what (customer side)
| Action | Owner | Approver | Outlet manager |
|---|---|---|---|
| Browse, order | every outlet | every outlet (never held) | own outlet (or all when unscoped); held when the account needs approval |
| See orders | all | all | own outlet's |
| Approve / reject held orders | ✓ | ✓ | — |
| Edit / cancel own placed order within the window | ✓ | ✓ | ✓ |
| Payments page, statements, pay online | ✓ | view | view |
| Business details, delivery area, documents | ✓ | — | — |
| Outlets (add / edit), Team (invite / roles / disable) | ✓ | — | — |
| Map pin | primary outlet | — | own outlet |
| Help, tickets | ✓ | ✓ | ✓ |

Staff: `customers:view` sees outlets and members (Customers → Account); `customers:edit` adds outlets, invites, disables
members and sets the approval override (Terms); `orders:edit` picks the outlet when ordering for a customer. The kitchen
sees "Awaiting approval" on held orders and cannot confirm them.

## Inviting a member (how it flows)
1. Owner: Account → Team → *Invite a member* (name, email, role, outlet) → `customer-users` Edge Function.
2. The function checks the caller (owner, or staff with `customers:edit` in scope) and calls `auth.admin.inviteUserByEmail`
   with the member metadata. An email with a one-time link goes out (Supabase's mailer or your SMTP, section 2 of
   `docs/deployment.md`). If the email already has a plain customer login with no account of its own, it is attached directly.
3. `handle_new_user` creates the profile (role `restaurant`) and the `customer_users` row — no new restaurant.
4. The invitee opens the link → `reset.html` → sets a password → signs in on the customer login page and sees the account.
5. Stuck invite? The owner can re-invite (same email attaches), or staff use Customers → Access backups as for any login.

## Notes
* An order's money still belongs to the account: one balance, one credit limit, one statement, whatever the outlet.
  Per-outlet spend is in the Ordering+ batch (spend reports).
* Held orders do reserve stock (counted mode) like any placed order, so a rejection returns it.
* There is no customer message for "order awaiting approval" yet: the owner already receives the *order placed* SMS /
  email, and the Approvals tab carries a count. Adding the event needs the `notification_settings.event` check widened
  (a `DROP CONSTRAINT`, which goes through the SQL editor) — planned with the WhatsApp provider in P2-7.
