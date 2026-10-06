# 0002 — No custom API server
**Status:** Accepted

**Context.** A separate API means more code, hosting and attack surface.

**Decision.** Reads go through RLS-protected tables. Writes go through `SECURITY DEFINER` Postgres functions that re-check the caller's role, set `search_path = ''`, and are executable only by `authenticated`. Direct browser writes to orders and profiles are revoked.

**Consequences.**
+ Fewer moving parts; business rules sit next to the data and run in one transaction.
− Logic is in SQL (covered by `security_test.sql`).
− The Supabase advisor reports "SECURITY DEFINER function callable by signed-in users" warnings. These are **intentional and accepted**: each function enforces its own role check.
