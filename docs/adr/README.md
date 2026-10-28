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
| [0013](0013-pricing-engine-rules-and-board.md) | Prices come from a formula in the database, mirrored in the browser |
| [0014](0014-variants-as-products-price-lists-as-a-layer.md) | Pack sizes are products; price lists are a layer over the published price |
| [0015](0015-procurement-po-grn-buying-list.md) | One receipt path (GRN), purchase orders as the plan, buying list planned forward |
| [0016](0016-fulfilment-batches-trips-pod.md) | Batches are an expiry overlay, trips carry the POD, cash is tracked per driver |
| [0017](0017-order-edit-slots-credit-notes.md) | One order core for place / edit / on-behalf; slots gate ordering; issues raise credit notes |
| [0018](0018-launch-control-lite-mode.md) | Launch control: lite mode is three switches over one codebase, not a second app |
| [0019](0019-open-item-receivables.md) | Receivables are open items computed from receipts and allocations; every paid order has a receipt |
| [0020](0020-customer-access-never-stuck.md) | A sign-up never dead-ends on an email: self-service resend plus staff-side backups |
| [0021](0021-customer-edit-window.md) | A short, per-sector window for customer self-edit and cancel |
