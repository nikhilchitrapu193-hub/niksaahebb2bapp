---
name: fs-feature
description: Build a Fresh Supply feature end to end (migration → security test → api.js → screen → consistency sweep → page test → docs). Use for "add a feature", "build the X screen", "implement Phase N item", or /fs-feature.
---

# Add a feature to Fresh Supply

Read AGENTS.md and docs/code-rules.md first. Then work in this order; do not skip a step.

## 1. Scope (ponytail)
Write down, in one short list, every file the change touches: migration, security test, api.js, screen, main.js route, tests, docs. If the request is vague, build the smallest version that does the core job and name what you left out.

## 2. Database first
- New file `supabase/migrations/2026MMDDNNNNNN_<name>.sql`. Never edit an applied one. Replacing a function with a new signature: rename the old one `*_legacy` and revoke it (no DROP).
- Every table: RLS on, `revoke all ... from anon` unless the public site needs it, policies that use `has_permission()` / `in_my_scope()`.
- Every function: `security definer`, `set search_path = ''`, first lines check the caller, then business rules with a comment naming the rule. Revoke from `public, anon`; grant to `authenticated`.
- Add a numbered check (next free T-number) to `supabase/tests/security_test.sql` for each new rule, including one that proves the wrong role is refused.
- If you have local Postgres: `supabase/tests/local_postgres_stub.sql` → migrations → seed → security test; every line PASS.

## 3. api.js wrapper
One named async function per call, JSDoc with the argument shape. Pages never import supabase.js.

## 4. Screen
`web/js/pages/<app>/<thing>.js` exporting `render<Thing>(container, me)`. Load through api.js, render with `html```, wire events with `on()`. Hide buttons with `can(me, module, action)`. Add the route and (if a module) the nav entry in `config.js` MODULES.

## 5. Consistency sweep (docs/code-rules.md rule 7)
Grep for every table, column, function and label you touched and walk every hit. Checklist:
- a new column → the form that edits it, the list that shows it, the CSV export, `api.js` wrapper, test fixture, `docs/api.md`;
- a list from a table → every screen that offers a choice from it shows every active row (no quiet filters in seed data);
- a SQL rule with a JS mirror → change both, and the shared numbers in `security_test.sql` and `tests/unit.test.js`;
- wording → labels name the general thing, not the first customer type we launched with.

## 6. Tests
- Pure helper → `tests/unit.test.js`.
- Screen → `tests/pages.test.js` using `setup({ session, profile, tables, rpc })`; assert what it renders and which backend calls it makes (`fake.calls`).
- `npm test` must be green.

## 7. Docs
`docs/api.md` (functions, tables), `docs/roles.md` (new permission), `docs/runbook.md` (how staff use it), an ADR in `docs/adr/` for any decision someone could reasonably have made differently.

## 8. Hand over
List the changed files with their paths, mark NEW ones, and say in two lines what you skipped or could not check.
