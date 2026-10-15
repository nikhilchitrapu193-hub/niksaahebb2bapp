---
name: fs-review
description: Review a Fresh Supply change like the senior developer who gets paged when it breaks — correct, safe, scale, tested, fast, lean — in plain English. Use for "review this", "code review", "is this over-engineered", or /fs-review. Adapted from ponytail-review and thermos.
---

# Review a change

Review what the user names (uncommitted changes by default). Read the diff AND the code it touches: callers of every changed function, the SQL functions and policies behind every api.js call, the tests. Grep every caller when a signature or return value changes.

Expected load: a few hundred orders a day, one Supabase project, a handful of staff. Judge scale against that and say so.

## Look for, in this order
1. **Bug** — wrong result, crash, missed edge case (empty cart, zero stock, last unit, rounding of GST, dates in IST, a customer with no warehouse, a role with no ticks).
2. **Risk** — a write that bypasses `has_permission` / `in_my_scope`; a new table without RLS or with anon grants; data from the browser trusted in SQL (prices, roles, quantities); markup built without `html```; a secret in `web/`.
3. **Scale** — check-then-write without `for update`; a query per row in a loop; lists that only grow.
4. **Missing test** — new rule with no security_test check, new screen with no page test, new helper with no unit test.
5. **Speed** — only real slowdowns.
6. **Lean** — dead code, an option nobody sets, a wrapper that only passes through, a function doing two jobs, duplicated SQL between two functions. Be ambitious: if a reframe makes a whole branch or helper disappear, say so.

## Check before you report
Every finding needs a concrete case: "this input leads to this wrong result". Re-read the lines and confirm the caller exists, the value can really be empty, the code really is unused. A `shortcut:` comment that names its limit is a decision, not a finding, unless the expected load crosses it. Propose the smallest fix; prefer fixes that delete code.

## Output
Very plain English. Start with `What this change does:` in two or three sentences. Then numbered findings in three groups (skip empty ones): **Must fix** (bug, security, data loss), **Should fix** (untested risky code, duplication, mixed jobs), **Nice to have**. Each finding: location, **What this is**, **Problem**, **Fix**, **If we skip it**. End with `Verdict: Ship.` or `Verdict: fix 1 and 3 first.`, `Lean: -N lines possible.` when relevant, and `Not checked:` for anything you could not verify. Lists findings; changes no code.
