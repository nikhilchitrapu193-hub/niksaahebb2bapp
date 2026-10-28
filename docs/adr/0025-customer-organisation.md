# 0025 — One account, many outlets and members; approval as an order flag, not a status
**Status:** Accepted

**Context.** Hotels, institutions and cantonments buy from several kitchens under one contract and one credit line,
and more than one person orders: a mess manager raises the indent, an officer approves, a purchasing head sees the
whole. Phase 1 modelled a customer as one `restaurants` row owned by one login (`owner_id unique`), and every table,
policy and function keys on that row through `my_restaurant_id()`.

**Options considered.**
1. An organisation table above `restaurants`, with each outlet as its own `restaurants` row (own balance, terms, orders).
2. Keep `restaurants` as the account and add `outlets` beneath it; members resolve to the account.
3. A new `order_status` value (`awaiting_approval`) for held orders.

**Decision.**
1. **Option 2.** The account stays the commercial unit (terms, credit, balance, statements, price lists); outlets are
   delivery points. Every existing account gets a primary outlet copied from its address, and a pair of triggers keep
   the primary outlet and the account's address columns identical in both directions. Older screens and functions see
   no change; new ones read outlets.
2. **Members resolve through `my_restaurant_id()`.** A `customer_users` row maps a login to an account with a role and
   an optional outlet; `my_restaurant_id()` returns the owner's account or the member's. Because Phase 1 keyed every
   customer-side policy and function on that one function, members inherited the whole app in one change; only three
   policies (restaurants, profiles, orders) and the owner-only functions needed edits.
3. **The order core is untouched.** `place_order` builds a `restaurants` record whose address / city / warehouse / pin
   come from the chosen outlet (`restaurant_for_outlet`) and hands it to the unchanged `place_order_core` and
   `rebuild_order_lines`, then stamps `outlet_id`. Stock, slots, fees, credit and messages all keep working.
4. **Approval is a flag (`orders.approval_status`), not a status (option 3 rejected).** Adding an enum value cannot be
   used in the same transaction as the migration, would touch every status switch in SQL and JS, and would make a held
   order invisible to the pick-list / reports logic that keys on `placed`. A held order is a placed order the kitchen
   may not confirm; `set_order_status` enforces that one rule.
5. **Only outlet managers are held.** Owners and approvers are the authority; staff orders are on the customer's
   instruction. Single-login accounts therefore behave exactly as in Phase 1 even in sectors that require approval.
6. **Invites run through an Edge Function** (service role) with metadata the sign-up trigger understands, the same
   pattern as `invite-staff`; no second login path.

**Consequences.**
+ No data migration beyond creating primary outlets and owner member rows; nothing changes for existing customers until
  they add an outlet or a member.
+ One balance per account matches how credit is actually granted; per-outlet spend is a report, not a ledger.
− An outlet manager scoped to one outlet still shares the account's credit limit with the others; a per-outlet cap is
  a later term if a customer asks.
− Rejection reuses the cancel path, so a rejected order shows as *cancelled* with the approver's note in the history.
