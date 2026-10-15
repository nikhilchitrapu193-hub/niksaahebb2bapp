# 0009 — Cities, warehouses and stock per warehouse from day one
**Status:** Accepted

**Context.** The business starts in Visakhapatnam but must grow to several cities without a rewrite.
Stock was one number per product (`products.stock_qty`); orders and customers had no location.

**Decision.** Migration 006 adds `cities`, `warehouses` (one default per city) and `service_zones`
(one pin code → one warehouse). Every order, customer and stock movement carries `city_id` and
`warehouse_id`. Stock is held in `warehouse_stock` per warehouse; `products.stock_qty` stays as the
total so existing screens keep working. `place_order` reserves stock in the customer's warehouse,
which is derived from their pin code at sign-up (or set by an admin). Existing data is backfilled into
one city ("Visakhapatnam") and one default warehouse.

**Alternatives considered.**
- *Keep one stock number and add a city label only.* Cheapest, but a second warehouse would need the
  rewrite this decision avoids.
- *Map polygons for zones.* More precise than pin codes but needs a maps dependency; pin codes are what
  customers know and what Hyperpure asks for. Polygons can be added later without changing the model.

**Consequences.**
+ A new city is set-up work (city, warehouse, pin codes), not code.
+ Reports can filter by city; team members can be limited to a city or warehouse (ADR 0010).
− Customers with an unserved pin code cannot be approved until an admin sets a warehouse.
− Two stock figures (per warehouse and total) must stay in step; only `apply_stock_movement` may touch them.
