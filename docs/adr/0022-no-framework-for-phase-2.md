# 0022 — Phase 2 stays with no framework and no build step (ADR 0003 revisited)
**Status:** Accepted

**Context.** ADR 0003 chose plain HTML, CSS and ES modules for Phase 1 and said the choice would be revisited before
Phase 2. Phase 1 is shipped: 18 migrations, ~45 screens across four apps (website, customer, admin, driver), one
pattern everywhere — a page module renders with the `html```` tag, reads and writes through `api.js`, listens with
`on()`. Phase 2 adds roughly as much again (customer organisations, standing orders, contract pricing, suppliers,
warehouse operations, finance reports, growth, a logistics adapter).

**Options considered.**
1. Keep the pattern.
2. Move to a framework (React / Vue / Svelte) with a bundler.
3. Add a build step only (TypeScript, bundling) while keeping the DOM pattern.

**Decision.** Option 1. The owner's rule is "any developer can read it, no magic"; a framework now means rewriting
every existing screen for no feature gain, a toolchain to maintain, and a hosting change (today the site is a folder of
files on any free static host). What a framework would give us — components, state, routing — we already have in a
small form (`ui.js`, per-page state objects, `shell.js` router) and it has held up through eight batches and three
hotfixes. The costs that were worrying at the start (no types, hand-written DOM) have been contained by the
conventions: every backend call in `api.js`, every rule mirrored in a pure JS module with shared test numbers, page
tests through a fake client. Option 3 is deferred: TypeScript would help, but it forces a build and breaks the
"open the folder and it runs" property; the Edge Functions are TypeScript already, where Deno runs it without a build.

**Rules that keep this working through Phase 2.**
* One screen = one module under `web/js/pages/<app>/`, exporting `render<Name>(container, me | state)`.
* No screen talks to Supabase directly; every call is a named function in `api.js` with a one-line comment.
* Pure rules (arithmetic, state machines, template rendering) live in `web/js/core/*.js`, mirror the SQL, and share
  test numbers with `security_test.sql`.
* Shared UI bits are functions returning `html```` fragments (`statusBadge`, `contactLinks`, `settingsTabs`), not a
  component system.
* A module over ~400 lines is split by tab or dialog, as `payments.js` / `grn.js` already are.

**Consequences.**
+ Phase 2 starts on day one; nothing is rewritten; hosting and onboarding stay trivial.
+ The whole app stays debuggable with the browser's own tools: view source is the source.
− No type checking in the browser code; mistakes are caught by tests and the fake client rather than a compiler.
− Large tables are rendered as strings; if a Phase 2 screen needs thousands of live rows (the stock valuation report,
  say) it paginates or filters server-side rather than virtualising the DOM.
