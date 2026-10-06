# Roles & permissions

| Capability | Restaurant | Delivery | Admin |
|---|:-:|:-:|:-:|
| Browse active products | ✅ (once signed in) | – | ✅ (incl. hidden) |
| Place order | ✅ approved only | – | – |
| See orders | own | assigned to them | all |
| Cancel order | own, while `placed` | – | any non-final |
| Confirm / pack | – | – | ✅ |
| Dispatch / deliver | – | assigned orders | ✅ |
| Assign driver | – | – | ✅ |
| Manage products, categories, photos | – | – | ✅ |
| Approve / suspend restaurants | – | – | ✅ |
| Change user roles, deactivate users | – | – | ✅ (not themselves) |
| Receive stock, adjust / write off, view ledger, suppliers | – | – | ✅ |
| Mark orders paid / unpaid, see credit owed | – | – | ✅ |
| Company settings (invoice details) | – | – | ✅ |
| View / print GST invoice | own orders | – | all |
| Browse public catalogue (logged out) | anyone | | |

**Login areas:** `/restaurant/login.html` (sign in + register), `/admin/login.html` and `/delivery/login.html` (sign in only).
An account that signs in on the wrong page is signed out with a hint; the database enforces the real restriction.

**Restaurant status:** `pending` (default) → `approved` → optionally `suspended`.
**Deactivated users** (`is_active = false`) see nothing and are signed out of the apps.

## Adding a new role

1. Add the value to the `user_role` enum in a new migration.
2. Extend RLS policies and role checks in the relevant functions.
3. Add an entry to `ROLE_HOME` in `web/js/core/config.js` and a new `web/<role>/` app.
4. Add cases to `supabase/tests/security_test.sql`.
