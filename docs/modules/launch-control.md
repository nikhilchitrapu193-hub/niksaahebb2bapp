# Module: Launch control ("lite mode")

Phase 1, batch 7 in `docs/build-roadmap.md`. Shipped as migration 014
(`supabase/migrations/20261020000001_launch_control.sql`).

## What it does, in one paragraph
One codebase, one database, three switches under **Settings → Launch**. **Live sectors** (`sectors.is_active`) decide who
can sign up and order: launch with army cantonments only, switch restaurants on when there are enough of them, then caterers
— one tick each, no deploy. **Pricing mode** decides whether prices are typed on the product form (*simple*) or come from
the pricing engine (*advanced*, migration 009); simple hides the Pricing menu. **Stock mode** decides whether stock is a
quantity ledger (*counted*, migrations 004/006/011/012) or only an in-stock / out-of-stock flag per product (*simple*);
simple hides Inventory and Procurement and orders never reserve stock. Nothing is deleted when a switch is off; turning it
back on shows everything exactly as it was. The order → pack → dispatch → deliver → track flow is the same in every mode.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261020000001_launch_control.sql` |
| Security test | `supabase/tests/security_test.sql` T57 |
| Core JS | `web/js/core/launch.js` (pure rules: `hiddenModules`, `isSimplePricing`, `isSimpleStock`, `isLite`, `launchSummary`), `config.js` (`LAUNCH_PRICING_MODES`, `STOCK_MODES`), `permissions.js` (`visibleNav(me, hidden)`), `api.js` "Launch control" |
| Admin screens | `web/js/pages/admin/launch.js` (Settings → Launch); `main.js` (menu + "Switched off" guard); `products.js` (simple form); `dashboard.js` (banner); `settings.js` tab; `customers.js` ("sector off" badge) |
| Customer app | `restaurant/main.js` (sector-off banner, ordering closed); `login.js` (only live sectors on the sign-up form) |
| Tests | `tests/unit.test.js` (launch rules), `tests/pages.test.js` (Launch screen, lite menu + product form, customer banner, sign-up list) |
| Docs | this file, `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, ADR 0018 |

## Settings
| Setting | Where | Values | Effect |
|---|---|---|---|
| Live sector | `sectors.is_active` (Launch screen switch; also the Active tick on Sectors & terms) | on / off | off: no sign-up (`handle_new_user` falls back), no orders (`place_order_core` refuses), customer app shows why (`my_order_terms.sector_active`) |
| Pricing mode | `company_settings.pricing_mode` | `simple` / `advanced` (default) | simple: product form is name + price + essentials with the rest folded; saving writes `price_source = 'manual'`; Pricing menu hidden |
| Stock mode | `company_settings.stock_mode` | `simple` / `counted` (default) | simple: no quantity check, no reservations, Inventory + Procurement hidden, "On hand" column gone; the In stock toggle is the control |

## Functions
| Function | Who | Does |
|---|---|---|
| `launch_status()` | settings:view | the modes, product counts and per-sector customers / approved / pending / orders in 30 days |
| `stock_mode()` | internal | reads the switch for the stock functions |
| `apply_stock_movement()` (replaced) | internal | every order-linked movement (`order`, `order_cancelled`, `returned`) follows `orders.stock_reserved`; an order that never reserved moves nothing |
| `rebuild_order_lines()` (replaced) | internal | the availability check runs only in counted mode; sets `orders.stock_reserved` to the mode in force; the in-stock flag always applies |
| `place_order_core()` (replaced) | internal | refuses a sector that is off |
| `my_order_terms()` (replaced) | customer | adds `sector_code`, `sector_active` |

## Business rules
| Rule | Where |
|---|---|
| a sector that is off takes no orders and no sign-ups | `place_order_core`, `handle_new_user` (006) |
| an order keeps the stock mode it was placed (or last edited) in — `orders.stock_reserved` — and only returns what it took, so the switch is safe at any time | `rebuild_order_lines`, `apply_stock_movement` |
| in simple stock mode the in-stock flag is the stock control | `rebuild_order_lines` |
| a hidden module is not granted by being switched on again: the permission matrix still applies | `visibleNav`, `main.js` guard |
| the two modes are company-wide, not per user | `company_settings` (one row) |

## How to launch with army cantonments only
1. Settings → Launch: switch **Restaurants**, **Hotels & caterers**, **Hospitals…** and **Small retailers** off; leave
   **Army cantonments & unit messes** on. Pricing → **Simple**. Stock → **Simple**. Save modes (the page reloads).
2. Products → Add product: name, SKU, category, price, unit, GST, minimum; tick In stock.
3. Customers → approve each cantonment account (the defence sector already requires a PO number per order and gives 60 credit days; change under Sectors & terms).
4. Orders arrive → Confirm → Pack → Fulfilment → Trips → Dispatch → the driver completes delivery with the code.
5. When restaurants are ready: Launch → switch Restaurants on. Nothing else changes.

## Not in this batch
Per-user modes (the switches are company-wide), a sector-specific home page per customer type (Phase 2), buy-to-order in
counted mode (the ADR 0007 question stays answered "no" for counted mode; simple mode is the lite answer).
