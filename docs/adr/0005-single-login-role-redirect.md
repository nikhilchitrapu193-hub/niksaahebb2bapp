# 0005 — One login page, role-based redirect
**Status:** Superseded by [0008](0008-separate-login-areas.md)

**Context.** Three roles could each have their own login page.

**Decision.** One sign-in page. After login the user is sent to `/admin/`, `/restaurant/` or `/delivery/` by `profiles.role`. Each app calls `requireRole()` on load.

**Consequences.**
+ One place to maintain auth and password reset; roles can change without new URLs.
− The page is shared, so branding is shared. Security never depends on the redirect: the database enforces roles.
