---
name: fs-security-check
description: Run the Fresh Supply security checklist on the current changes — RLS, grants, permission and scope checks, secrets, escaping — and the SQL security test. Use before finishing any change that touches supabase/ or api.js, or /fs-security-check.
---

# Security check

The database is the only security boundary in this app (docs/architecture.md). Walk this list against the diff; answer each item with the file and line that proves it, or "N/A".

## Migrations
- [ ] Every new table: `enable row level security`; `revoke all on <table> from anon` unless the public site must read it (then a `for select to anon` policy with an explicit `using`).
- [ ] Every write path is either a `security definer` function or a policy whose `using` / `with check` calls `has_permission()` (and `in_my_scope()` for rows with a city / warehouse).
- [ ] Every function: `set search_path = ''`, fully qualified names, caller checked in its first lines, `revoke execute ... from public, anon` and `grant ... to authenticated` (anon only for the public pin-code style helpers).
- [ ] Nothing the browser sends decides price, role, stock, status or permission. Prices come from `products`, roles change only through `admin_set_team_member` / `admin_set_user_role`, stock only through `apply_stock_movement`.
- [ ] Rows are locked (`for update`) before a check-then-write (stock, order status, customer status).
- [ ] Replaced functions with a new signature are renamed `*_legacy` and revoked; applied migrations are untouched.
- [ ] New sensitive tables (costs, margins, audit) are never granted to anon and never readable by customers.

## Browser
- [ ] Pages import only `api.js` (grep `from '../core/supabase.js'` outside core/ → must be empty).
- [ ] All markup goes through `html``` (grep `innerHTML =` outside ui.js → must be empty).
- [ ] No `sb_secret_`, `service_role` or private key in `web/` (`tests/static.test.js` checks this).
- [ ] Buttons hidden with `can()` have a matching SQL check; the UI is never the only gate.

## Run
1. `npm test` — all green.
2. `supabase/tests/security_test.sql` in the Supabase SQL editor (or locally after `local_postgres_stub.sql`): every line starts with PASS. Add a T-check for each new rule, including a negative one (wrong role refused).

Report: the checklist with evidence, the two test results, and anything you could not verify.
