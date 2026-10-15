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
