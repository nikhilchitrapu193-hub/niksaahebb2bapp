# 0012 — Audit log written by a database trigger
**Status:** Accepted

**Context.** The owner wants to know who changed prices, orders, payments, customers, permissions and
settings, and when. Logging from the browser or from each function would miss direct table writes and
could be skipped by a bug.

**Decision.** One generic trigger function `write_audit_log()` attached to the tables that matter. It
records `table_name`, `row_id`, `action`, `changed_by` (`auth.uid()`), and for updates only the changed
columns as `{col: {old, new}}`. Nobody can write to `audit_log` from the API; `audit:view` reads it.
Stock is *not* duplicated here: `stock_movements` is already its ledger, so the products trigger lists
its columns and leaves `stock_qty` out.

**Consequences.**
+ Nothing can change those tables without a trail, whatever path the change took.
+ Rows are small (changed columns only) and indexed by table, row and time.
− Bulk updates (a future CSV price upload) write one audit row per product; acceptable at this scale,
  and `audit_log` can be partitioned or pruned later.
