# Module: Pricing engine, part 1 (rules, benchmarks, price board)

Build list section 4, Phase 1 (batch 2 in `docs/build-roadmap.md`). Shipped as migration 009
(`supabase/migrations/20261015000004_pricing_engine.sql`). The full spec is the project document
*Pricing & Finance Engine: build plan*; this batch is its phase 1.

## What it does, in one paragraph
Every selling price comes from one visible formula: landed cost (buying cost + transport and handling per
kg + packing, with the market fee, yield and wastage applied) × (1 + markup), held under a benchmark
cap and rounded to the category's step. The variables live per category in `pricing_rules` (with
effective dates, old rows kept) and can be overridden per product. Costs come from the stock ledger
(latest receipt or 30-day weighted average), today's supplier quote, or a typed number. Market rates
(Rythu Bazaar, NECC, DoCA, METRO, harbour…) are entered each morning or uploaded as CSV and shown to
customers as the struck-through "market rate" with the source and date. The daily price board shows all
of it per product with warning flags; "Publish" writes the prices (now or at a scheduled time), keeps
a price history, and refuses or warns when a price is below cost or under the minimum markup. Order
lines snapshot their landed cost in a staff-only table so margin reports never change later. Products
carry an HSN code (printed on invoices) and a pack size so per-kg costs work for tins and trays.

## The formula
```
landed   = (cost + weight_kg × (transport_per_kg + handling_per_kg) + packing_per_unit)
           × (1 + market_fee_pct/100) × (1 + other_cost_pct/100)
           ÷ (yield_pct/100) ÷ (1 − wastage_pct/100)
raw      = landed × (1 + markup_pct/100)                       -- mode 'rule'
         | benchmark + fixed_margin_amount                     -- mode 'fixed_over_benchmark' (eggs: NECC + ₹9/tray)
         | manual_price                                        -- mode 'manual'
raw      = min(raw, benchmark × (1 + benchmark_cap_pct/100))   -- cap, not for manual
price    = round(raw, rounding_step, round_mode)              -- ₹0.50 / ₹1 / ₹5, nearest or up
flags    = no_cost · no_benchmark · manual · capped · below_cost · below_min_markup · stale_benchmark (> 3 days) · cost_moved (> 10 % between latest and average)
```
`cost` = by `cost_method`: 30-day weighted average of received stock (default, falls back to the
latest receipt), latest receipt, today's supplier quote, or a typed cost. With nothing on file the quote
is used; with no quote either the product gets no suggestion and the `no_cost` flag.

The SQL function is `compute_price_from(jsonb)`; the JS mirror is `computePrice()` in
`web/js/core/pricing.js`. They are tested on the same numbers (SQL T30a–e ↔ `tests/unit.test.js`).

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261015000004_pricing_engine.sql` (tables, views, formula, publishing, `place_order` v4, RLS) |
| Security test | `supabase/tests/security_test.sql` T2e, T30–T39 |
| Seed | `supabase/seed.sql` (HSN + pack sizes for the sample catalogue, category rules, egg and chicken overrides, sample quotes) |
| Core JS | `web/js/core/pricing.js` (**the formula**), `config.js` (MODULES.pricing, PACK_UNITS, PRICING_MODES, COST_METHODS), `csv.js` (`parseCsv`), `api.js` (Pricing section) |
| Admin screens | `web/js/pages/admin/price-board.js` (board + product drawer = landed-cost / yield / margin calculator), `pricing-rules.js`, `benchmarks.js`; updated `main.js` (routes), `products.js` (HSN, pack size, read-only board price), `settings.js` (prices incl. GST) |
| Customer side | `restaurant/catalogue.js` (`displayPrice`, benchmark label), `landing.js`, `invoice.js` (HSN column, delivery fee line) |
| Tests | `tests/unit.test.js` (formula, CSV, rule picker, display price), `tests/pages.test.js` (board, rules, benchmarks, product form, catalogue, invoice) |
| Docs | this file, `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, ADR 0013 |

## Tables (all staff-only except `hsn_codes`)
| Table | Holds |
|---|---|
| `hsn_codes` | GST classification codes with a default rate (any signed-in user may read) |
| `pricing_rules` | one row per category per effective period; `category_id NULL` = global default |
| `product_pricing` | per-product overrides, mode, yield, quote, manual price / cost |
| `benchmark_sources`, `benchmark_prices` | market-rate sources and one rate per source / product / day |
| `price_history` | every published price with the cost, markup, benchmark and rule snapshot behind it |
| `scheduled_prices` | approved prices waiting for their time; `publish_due_prices()` applies them |
| `order_line_costs` | landed cost per order line at order time (customers never see it) |
| views `v_product_cost`, `v_product_benchmark` | latest / average cost and latest benchmark per product |

`products` gained `hsn_code`, `pack_size`, `pack_unit`, `price_source`, `price_updated_at`,
`benchmark_label`, `benchmark_date` (all safe for customers to see). `order_items` gained `hsn_code`.
`stock_movements` gained `seq` (ledger order). `company_settings` gained `show_prices_incl_gst`.

## Business rules (each is one named function)
| Rule | Where |
|---|---|
| The rule in force on a date is the category's own, else the global one | `effective_pricing_rule()`; `ruleInForce()` in `pricing-rules.js` |
| Product override → category rule → global rule, variable by variable | `pricing_inputs()` |
| The formula | `compute_price_from()` ↔ `computePrice()` |
| Never sell below cost or under the minimum markup without saying so | `apply_prices()`: `guard_mode` warn (needs `p_force`) or block |
| Published prices carry their benchmark label for customers | `publish_price()` sets `market_price`, `benchmark_label`, `benchmark_date` |
| A price published from the board is not overwritten by the product form | `saveProduct()` drops `price` / `market_price` when `price_source = 'rule'` |
| Scheduled prices go live when due | `publish_due_prices()` — pg_cron every 5 min where enabled, and when the board opens |
| Order lines snapshot HSN and landed cost | `place_order()` v4 → `order_items.hsn_code`, `order_line_costs` |
| Costing data is staff-only | RLS on every table above; `anon` revoked; `compute_price` / `price_board` check `pricing:view` |

## Permissions (module `pricing`)
`view` board, rules, benchmarks, history · `edit` enter benchmarks and quotes, change rules and overrides
· `approve` publish and schedule prices, cancel scheduled ones · `export` CSV. Seeded: pricing_manager and
city_manager all four; procurement_buyer view + edit (they type the mandi rates).

## Starting values (from the Vizag pricing research; review after 4–6 weeks)
| Category | Markup | Min | Wastage | Step | Cap | Benchmark |
|---|---|---|---|---|---|---|
| Vegetables | 15 % | 8 % | 8 % | ₹0.50 | 10 % | Rythu Bazaar |
| Fruits | 15 % | 8 % | 10 % | ₹0.50 | 10 % | Rythu Bazaar |
| Dairy & Eggs | 4 % | 2 % | 2 % | ₹1 | – | Distributor; eggs = NECC + ₹9 / tray |
| Poultry & Meat | 10 % | 5 % | 3 % | ₹5 | – | Distributor; chicken yield 70 % |
| Grains & Pulses | 5 % | 2 % | 0.5 % | ₹1 | 5 % | DoCA |
| Oils & Spices / Packaged | 5 % | 2 % | 0.5 % | ₹1 | 5 % | METRO shelf |
| Kitchen Essentials | 8 % | 3 % | 0 % | ₹1 | – | METRO shelf |
| Global default | 10 % | 3 % | 2 % | ₹1 | – | newest of any |

## Not in this batch
Price lists per city / sector and contract rates (batch 3 / Phase 2), quantity slabs, price-change
approval above a %, actual-vs-assumed wastage, purchase GST on receipts and the ITC register, margin
reports and valuation (batch 9), what-if simulator, supplier comparison, automatic Agmarknet fetch
(Phase 3). The landed-cost / yield / margin calculators live in the board's product drawer rather than
as separate screens.
