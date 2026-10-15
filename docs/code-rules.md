# Code rules: so any developer can read and change this project

These rules apply to every file, whether a person or a coding agent writes it. They combine the
project's own conventions (AGENTS.md) with practices borrowed from four open-source projects:
[ponytail](https://github.com/dietrichgebert/ponytail) (the smallest complete change),
[pstack](https://github.com/cursor/plugins/tree/main/pstack) (boundary discipline, plain writing),
[thermos](https://github.com/cursor/plugins/tree/main/thermos) (strict maintainability review) and
[PentAGI](https://github.com/vxcontrol/pentagi) (comment discipline). Those projects are agent
tooling, not app code, so what we took is their *rules*, written for this codebase. The same rules
are installed for Cursor / Codex / Claude agents in `.cursor/rules/` and `.cursor/skills/`.

## 1. The smallest complete change (from ponytail)

- Solve the whole task with the least new code. Before writing, list every place the change must
  reach: callers, tests, fixtures, config, docs. That list is the scope; extra features are not.
- Reuse what the codebase has (`ui.js` helpers, `api.js` wrappers, existing CSS classes, the
  `setup()` test helper) the way the surrounding code uses it. No new runtime dependency, ever.
- No abstraction, option, wrapper or "for later" code that nobody asked for. Deletion beats addition.
- A shortcut with a known limit gets a comment in this form: `shortcut: <the limit>, <when to upgrade>`.
- Never cut: validation at trust boundaries, error handling that prevents data loss, security checks,
  accessibility, anything the user asked for.
- New non-trivial logic (a branch, money, a parser, security) ships with one small test.

## 2. Where logic lives (boundary discipline, from pstack)

- **The database is the boundary.** Every write goes through a SQL function that re-checks the caller
  (`has_permission`, `in_my_scope`, `app_role`). Validate there. UI checks only hide buttons.
- **Business rules are pure.** Each rule is one named function with a comment saying what rule it
  enforces and why (`place_order` checks approval, warehouse, MOV, PO, stock; `orderPreview` mirrors
  the MOV rule in the browser). Keep rules out of event handlers.
- **Fixed lists live in one place.** Statuses, slots, sectors, modules, actions and roles are config
  (`web/js/core/config.js`) and a table / check constraint in SQL. Never typed into a screen.
- **Screens are thin.** A page module loads data through `api.js`, renders with `html```, wires events
  with `on()`. If a page grows past ~250 lines, split by job (form, list, modal), never by line count.

## 3. Comments (from PentAGI)

- Every file starts with a header saying what it is for and the one or two things a reader must know.
- Inside the code, comment only what the code cannot show: why this choice, which external constraint,
  which rule is enforced. Never restate the line below. No history ("used to be"); git has it.
- Keep a comment correct: when you change the code, re-read the comment above it.

## 4. Writing for people (from pstack's "unslop")

Docs, commit messages, UI text and error messages use plain words and short sentences.
Say what something does, not how it feels. No "leverage", "robust", "seamless", "simply".
Error messages tell the person what to do next ("Set a delivery warehouse before approving").

## 5. Review standard (from thermos and ponytail-review)

Before a change is finished, review it as the person who will be paged when it breaks, in this order:
**correct → safe → holds under load → tested → fast → lean**. Every finding names a concrete case
("a customer with no warehouse would…"). Be ambitious about simplification: if a reframe would make a
whole branch or helper disappear, prefer it. The `/fs-review` skill runs this checklist.

## 6. House conventions that never bend (AGENTS.md)

Pages never call Supabase directly · markup only via `html``` · never edit an applied migration ·
stock only through the stock functions · orders snapshot prices · no frameworks or build step ·
`npm test` green and `security_test.sql` all PASS before finishing · docs and ADRs updated in the
same change.

## 7. A change lands everywhere the thing appears (consistency sweep)

Added on 15 Oct 2026 after the sign-up form offered two of the five sectors: migration 006 seeded
`can_self_register = true` for restaurants and hotels only, and nobody checked the form against the
sector list. The rule:

* **Reference data shows in full everywhere.** When a list comes from a table (sectors, cities, team
  roles, HSN codes, benchmark sources, categories…), every screen that offers a choice from it shows
  **every active row**. A filter is allowed only when it is a named business rule *and* the admin can see
  and change it (the `can_self_register` tick under Settings → Sectors is that rule; it now defaults on).
  Seed data must not quietly hide rows: a new row is visible unless someone decides otherwise.
* **Before finishing a change, grep for the thing you changed** and walk every hit: screens, tests,
  docs, seed, the SQL test. Columns added to a table go into the form that edits it, the list that shows
  it, the export, the fixture and `docs/api.md`. A rule changed in SQL is changed in its JS mirror
  (`place_order` ↔ `orderPreview`, `compute_price_from` ↔ `computePrice`) and in the test that proves
  both agree. The `/fs-feature` skill has this sweep as its step 5.
* **Wording follows the data.** Labels name the general thing ("Business / outlet name"), not the first
  sector we happened to launch with.

## 8. One formula, two copies, one set of numbers

Business arithmetic lives in SQL (the database is the source of truth and re-computes before writing)
and is mirrored in a pure JS module for instant previews. The two copies are kept honest by **shared
fixtures**: `security_test.sql` and `tests/unit.test.js` feed the same inputs and expect the same
outputs (T30 ↔ `computePrice` tests). Change both or neither; when you change one, the other's test
goes red.
