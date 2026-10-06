# 0004 — Vendor supabase-js
**Status:** Accepted

**Decision.** Commit the UMD build to `web/vendor/supabase.js` (version table and upgrade steps in `web/vendor/README.md`) and load it with a classic script tag before any module.

**Consequences.**
+ No CDN outage or supply-chain surprise; reproducible.
− Upgrades are manual (steps documented).
