# 0018 — Launch control: lite mode is three switches over one codebase, not a second app
**Status:** Accepted

**Context.** The business launches with army cantonments only, a handful of SKUs at typed prices, and no stock
counting — and will open restaurants and caterers later. The owner asked for a "lite version" of the app. Two ways to
get there: a separate simplified build (two codebases to keep in step) or switches over the full app.

**Decision.**
1. **Switches, not a fork.** Three settings, all under Settings → Launch, all enforced by the database:
   *live sectors* (`sectors.is_active`, already there; now also gates ordering, not only sign-up), *pricing mode*
   (`company_settings.pricing_mode`: simple / advanced) and *stock mode* (`company_settings.stock_mode`: simple / counted).
   Simple pricing hides the pricing engine screens and makes the product form a price field; simple stock hides
   Inventory and Procurement and makes the in-stock toggle the stock control. Nothing is removed from the schema; switching
   a mode back shows everything as it was.
2. **Per sector, not one global lite flag.** A sector is switched on when it has enough customers; the others wait.
   Launch → restaurants → caterers is three ticks over months, with no migration and no second deploy.
3. **The ledger stays honest across modes.** In simple stock mode orders do not reserve stock. To make the switch safe to
   flip at any time, each order records whether its lines reserved stock (`orders.stock_reserved`, set by
   `rebuild_order_lines`) and `apply_stock_movement()` makes every order-linked movement — reservation, packed-quantity
   correction, cancellation, doorstep return — follow that flag rather than today's mode: *an order only returns what it
   took*. An order placed in counted mode and cancelled in simple mode still returns its stock; one placed in simple mode
   and packed short or cancelled in counted mode moves nothing.
4. **Company-wide, not per user.** The modes describe the business, not a person; the permission matrix (ADR 0010) still
   decides who sees what inside the modules that are on. A hidden module is not granted by being switched on again.
5. **The flow does not change.** Order → confirm → pack → trip → deliver → track is identical in every mode; so are
   invoices, credit terms and the customer app. Lite is what the team *sees* and what the database *checks on stock and
   sectors*, not a different process.

**Consequences.**
+ One codebase and one test suite; the lite launch is a configuration, and growth is a tick per sector.
+ Products added in simple mode are ordinary hand-priced products; switching to advanced later just reveals the board.
− `rebuild_order_lines` is replaced (it already contained row-removal statements), so migration 014 must be applied from
  the SQL editor like 011–013 (`docs/deployment.md`).
− The menu is built once at start-up from the modes; changing a mode reloads the page.
