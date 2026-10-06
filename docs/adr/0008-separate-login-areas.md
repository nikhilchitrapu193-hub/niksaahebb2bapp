# 0008 — Separate login areas per role
**Status:** Accepted (supersedes 0005)

**Context.** The owner wants the Hyperpure pattern: a public marketing site, a partner login for restaurants, and separate staff logins. ADR 0005 had a single shared sign-in page.

**Decision.** `index.html` is the public site. Each role has its own page (`restaurant/login.html`, `admin/login.html`, `delivery/login.html`) rendered by one shared module (`js/pages/login.js`) parameterised by `data-role`. Only the restaurant page offers registration. Signing in on the wrong page signs the user out again with a hint. `requireRole()` redirects unauthenticated visitors to the matching login page.

**Consequences.**
+ Clear separation for users; the admin URL is not advertised on the restaurant form.
+ One module to maintain — the pages differ only by role.
− Security still comes from the database; the separate pages are UX, not a boundary.
