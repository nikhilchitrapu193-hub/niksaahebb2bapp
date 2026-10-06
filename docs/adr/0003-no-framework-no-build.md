# 0003 — No framework, no build step
**Status:** Accepted

**Context.** Requirement: every developer can understand and edit the code; free hosting; no tooling friction on Windows.

**Decision.** Plain HTML, CSS and ES modules, a hash router and an escaping `html` template helper. A zero-dependency Node server is used for local development only (ES modules do not load from `file://`).

**Consequences.**
+ Nothing to compile; deploying is uploading a folder.
− No component model or reactivity; screens re-render by replacing markup. If the app outgrows this, screens can be migrated one at a time because `api.js` is isolated.
