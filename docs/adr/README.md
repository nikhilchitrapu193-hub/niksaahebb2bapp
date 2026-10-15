# Architecture Decision Records

Short notes on *why* we chose something. Add a new numbered file for each significant decision; never rewrite history — supersede instead.

| # | Decision |
|---|---|
| [0001](0001-supabase-postgres.md) | Supabase Postgres instead of a JSON file or Sheets |
| [0002](0002-no-custom-api-server.md) | No custom API server; SQL functions + RLS |
| [0003](0003-no-framework-no-build.md) | Plain HTML/CSS/ES modules, no build step |
| [0004](0004-vendored-supabase-js.md) | Vendor supabase-js into the repo |
| [0005](0005-single-login-role-redirect.md) | One login page with role-based redirect |
| [0006](0006-google-login-roadmap.md) | Google sign-in deferred to roadmap |
| [0007](0007-inventory-ledger.md) | Stock is a movement ledger, not an editable number |
| [0008](0008-separate-login-areas.md) | Separate login areas per role (supersedes 0005) |
| [0009](0009-cities-warehouses-per-warehouse-stock.md) | Cities, warehouses and stock per warehouse from day one |
| [0010](0010-team-roles-permission-matrix-scope.md) | Team roles, permission matrix and city / warehouse scope |
| [0011](0011-sectors-and-trading-terms.md) | Sectors (customer types) carry the trading terms |
| [0012](0012-audit-log-by-trigger.md) | Audit log written by a database trigger |
