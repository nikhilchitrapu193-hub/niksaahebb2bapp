# 0001 — Supabase Postgres
**Status:** Accepted

**Context.** The first prototype used Express with a JSON file. That cannot enforce multi-user permissions, concurrent writes or relational integrity, and needs its own hosting. Google Sheets and no-code tools were rejected earlier (cost, limits, no real auth).

**Decision.** Use Supabase (Postgres + Auth + Storage) on the free tier.

**Consequences.**
+ Real relational integrity, transactions, RLS, auth and photo storage, all free.
− Vendor dependency (mitigated: it is standard Postgres and the migrations are plain SQL).
− Free projects pause after inactivity.
