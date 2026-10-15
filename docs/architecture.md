# Architecture

## Overview

The public site, three login areas and three apps are all static files. There is **no custom API server**; the browser talks straight to Supabase:

* **Reads** use table queries, filtered by Postgres **Row Level Security (RLS)**.
* **Writes that matter** (placing orders, changing status, managing users) call
  **Postgres functions** through `supabase.rpc()`. Each function re-checks the caller's role.
* The browser's API key is *publishable* (public by design). Direct writes to
  `orders`, `order_items`, `order_status_history` and `profiles` are revoked from browsers.

```mermaid
flowchart LR
  subgraph Browser["Browser (static files)"]
    L[Login page] --> R[Restaurant app]
    L --> A[Admin app]
    L --> D[Delivery app]
    R & A & D --> API["js/core/api.js"]
  end
  API -- "table reads (RLS)" --> PG[(Supabase Postgres)]
  API -- "rpc(): role-checked functions" --> PG
  API -- "photos" --> ST[(Supabase Storage)]
  L -- "sign in/up" --> AU[Supabase Auth]
  AU --> PG
```

## Layers (frontend)

```mermaid
flowchart TD
  P["js/pages/*  — screens (render + events)"] --> API["core/api.js — all backend calls"]
  P --> UI["core/ui.js — html`` escaping, toasts, modals, formatting"]
  P --> AUTH["core/auth.js — sign in/out, requireRole()"]
  API & AUTH --> SB["core/supabase.js — the one client"]
  SB --> CFG["core/config.js — URL, public key, locale"]
```

Rule: **pages never import the Supabase client directly** — they call `api.js`.
That keeps the data layer swappable and easy to test. (`shell.js` and `reset.js` use `auth.js` only.)

## Data model

```mermaid
erDiagram
  PROFILES ||--o| RESTAURANTS : owns
  RESTAURANTS ||--o{ ORDERS : places
  PROFILES ||--o{ ORDERS : "assigned driver"
  ORDERS ||--|{ ORDER_ITEMS : contains
  ORDERS ||--o{ ORDER_STATUS_HISTORY : logs
  CATEGORIES ||--o{ PRODUCTS : groups
  PRODUCTS ||--o{ ORDER_ITEMS : "snapshotted into"
  PRODUCTS ||--o{ STOCK_MOVEMENTS : "explains stock_qty"
  SUPPLIERS ||--o{ STOCK_MOVEMENTS : "received from"
  ORDERS ||--o{ STOCK_MOVEMENTS : "reserved / released"
```

`company_settings` is a single-row table with the seller details printed on invoices.

## Inventory

`products.stock_qty` is the quantity on hand. It is never edited directly: every change is a
row in `stock_movements` (reason: received, order, order_cancelled, adjustment, wastage,
returned) written by the internal `apply_stock_movement()` function.

```mermaid
flowchart LR
  S[Supplier] -- "Receive stock (GRN)" --> W[(stock_qty)]
  W -- "place_order reserves" --> O[Order]
  O -- "cancel restores" --> W
  W -- "adjust / wastage / return" --> W
  W --> L[(stock_movements ledger)]
```

Low stock = `stock_qty <= low_stock_threshold`; the admin dashboard and Inventory screen flag it,
and the restaurant catalogue shows "Only N left". Zero stock shows as out of stock.

Key decisions: orders **snapshot** product name, unit and price (later price edits never
change past orders); `line_total` is a generated column; money is `numeric(12,2)`.

## Order lifecycle

```mermaid
stateDiagram-v2
  [*] --> placed
  placed --> confirmed: admin
  confirmed --> packed: admin
  packed --> out_for_delivery: admin / assigned driver
  out_for_delivery --> delivered: admin / assigned driver
  placed --> cancelled: restaurant (own) / admin
  confirmed --> cancelled: admin
  packed --> cancelled: admin
  out_for_delivery --> cancelled: admin
  delivered --> [*]
  cancelled --> [*]
```

Dispatch requires an assigned driver. Enforced in `set_order_status()`, not in the UI.

## Placing an order

```mermaid
sequenceDiagram
  participant B as Browser
  participant F as place_order() (Postgres)
  B->>F: rpc(place_order, [{product_id, quantity}], notes)
  F->>F: check role = restaurant AND restaurant approved
  F->>F: merge duplicate lines, validate stock / minimum qty
  F->>F: read CURRENT prices, snapshot into order_items, compute total
  F-->>B: { id, order_number, total_amount }
```

The browser never sends a price. A tampered cart cannot change what is charged.

## Security model (summary)

1. Anonymous users can read only listed products and categories (for the public site).
2. Sign-up always creates role `restaurant`, status `pending` (role never read from user input).
3. Admins and delivery staff are created by invitation and promoted by an admin.
4. RLS limits reads: restaurants see their own orders; drivers see assigned orders; admins see all.
5. Every `SECURITY DEFINER` function sets `search_path = ''` and re-checks the role.
6. All HTML is built with the escaping `html` template, preventing XSS.

The 30-check regression test in `supabase/tests/security_test.sql` proves these rules.

## Cities, scope and permissions (migration 006)

```
city ──< warehouse ──< service_zone (pin code)
  │          │
  │          └──< warehouse_stock (per product)      products.stock_qty = sum over warehouses
  └──< restaurants (customer: sector_code, warehouse_id from pin code)
            └──< orders (city_id, warehouse_id, sector_code, po_reference, delivery_fee)

profiles.team_role ──> role_permissions (module × action)     has_permission(module, action)
profiles.city_id / warehouse_id                                in_my_scope(city, warehouse)
audit_log  <── write_audit_log() trigger on products, orders, restaurants, profiles, permissions, settings
```

Every admin-app function and policy asks those two questions. The browser asks the same ones
(`web/js/core/permissions.js`) only to decide what to show.

## Pricing (migration 009)

```
benchmark_prices ─┐                         ┌─ products.price / market_price / benchmark_label
stock_movements ──┼─► pricing_inputs() ─► compute_price_from() ─► apply_prices() ─┼─ price_history (why)
pricing_rules ────┤   (override → category   (the formula; mirrored     (guard, now or   └─ scheduled_prices → publish_due_prices()
product_pricing ──┘    → global, costs, bm)   by pricing.js)              scheduled)
```
The browser previews with `web/js/core/pricing.js`; the database recomputes before writing. Every table in
the left column is staff-only (`pricing` permission module). Order lines snapshot HSN on `order_items` and
landed cost in `order_line_costs`. Details: `docs/modules/pricing.md`, ADR 0013.
