# 0010 — Team roles, a permission matrix and city / warehouse scope
**Status:** Accepted

**Context.** `profiles.role = 'admin'` meant "can do everything". The owner wants to grant team members
access per module and action, limited to the city or warehouse they work in, and to change those
grants from a settings screen rather than in code.

**Decision.** Keep `profiles.role` as the *app* a login uses (admin / restaurant / delivery). Add
`profiles.team_role` (super_admin, city_manager, warehouse_manager, procurement_buyer, pricing_manager,
finance, sales, support, dispatcher, picker, driver), the table `role_permissions(team_role, module,
action)` and `profiles.city_id` / `warehouse_id` as scope. Two SQL helpers do the checks:
`has_permission(module, action)` and `in_my_scope(city, warehouse)`. Every admin-app function and
policy uses them instead of `app_role() = 'admin'`. `super_admin` needs no rows and is the only role
that may change the matrix or grant super admin. The browser mirrors the checks only to hide buttons.

**Alternatives considered.**
- *More enum values in `user_role`.* Simple, but a role change would need a migration and could not be
  limited per module.
- *Row-level grants per person.* Flexible, but hard to explain and audit. Role × module × action is what
  the owner asked for and what every ERP does.

**Consequences.**
+ The owner can create a "finance only" or "Vizag warehouse only" login without a developer.
+ Permission tests prove each role sees only what it should (security_test T20–T29).
− New features must name their module and action, and check it in SQL, or they are super-admin-only by accident.
− A promoted customer (role → admin) defaults to super_admin; the Team screen should set the right role straight away.
