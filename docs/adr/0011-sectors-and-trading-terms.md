# 0011 — Sectors (customer types) carry the trading terms
**Status:** Accepted

**Context.** Restaurants, hotels, institutions (hospitals, hostels), defence units and small retailers
buy differently: minimum order, delivery fee, credit days, purchase-order numbers, approval before
dispatch. Hard-coding "restaurant" rules into `place_order` would mean a code change per sector.

**Decision.** A `sectors` table (code, name, min_order_value, delivery_fee_below_mov, credit_days,
needs_po_reference, needs_order_approval, can_self_register) seeded with five sectors. A customer
(`restaurants.sector_code`) inherits its sector's terms and may override MOV, fee and credit days.
`place_order` reads the terms: below the minimum it charges the fee if there is one, else refuses; it
demands a PO reference where the sector needs one; it snapshots the sector on the order. The cart shows
the same rule through `my_order_terms()` and `orderPreview()` (same formula in SQL and JS, both tested).
`needs_order_approval` is stored now and enforced in Phase 2 (approval before dispatch).

**Consequences.**
+ Adding a sector is a row plus a line in the sign-up form, not a code change.
+ Terms are visible and editable by the owner (Settings → Sectors).
− The table is still called `restaurants`; renaming it would touch every screen for no behaviour gain, so
  the name stays and the table comment explains it.
