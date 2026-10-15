# Module: Catalogue + (category tree, variants, loose weight, price lists)

Build list sections 3 and 4, Phase 1 (batch 3 in `docs/build-roadmap.md`). Shipped as migration 010
(`supabase/migrations/20261015000005_catalogue_plus.sql`).

## What it does, in one paragraph
Categories have two levels (Vegetables › Leafy greens) and pricing rules inherit down the tree. A pack size
is its own product row (SKU, price, stock, HSN) linked to the main product, so the catalogue shows one card
with a pack picker while orders, stock and the price board work unchanged. Products carry grade, origin,
veg / non-veg, shelf life and a storage note, shown on a product page. Loose-weight items are ordered in kg,
weighed at packing and billed on the actual weight within a tolerance; other lines may be short-supplied.
The customer catalogue sorts and filters (brand, veg type, in stock). Products can be added or updated in
bulk from a CSV. Price lists put a % adjustment and fixed prices over the published price per city and / or
sector; the database charges that price, the customer app shows it.

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261015000005_catalogue_plus.sql` |
| Security test | `supabase/tests/security_test.sql` T40–T43 (and T2a / T3a / T32a counts: the seed now has a 25 kg rice bag) |
| Seed | `supabase/seed.sql` (sub-categories for the samples, grades, loose-weight flags, the rice bag) |
| Core JS | `web/js/core/catalogue.js` (tree, variants, filters, price-list merge — pure), `csv-import.js` (`csvToProducts`), `csv.js` (`readTextFile`), `shell.js` (prefix routes `#product/`), `config.js` (`VEG_TYPES`, `CATALOGUE_SORTS`), `api.js` |
| Admin screens | `web/js/pages/admin/price-lists.js` (new); `products.js` (tree select, details, variants, loose weight, CSV upload, category manager with parent); `orders.js` (packed quantities); `pricing-rules.js` (inherited rules); `price-board.js` (tree filter) |
| Customer side | `restaurant/catalogue.js` (sort, filters, sub-category chips, pack picker, "your price"), `restaurant/product.js` (new page), `restaurant/main.js` (price list applied, `#product/` route), `restaurant/orders.js` and `invoice.js` (ordered vs billed) |
| Public site | `landing.js` (top-level tiles with sub-category counts, variants not featured twice) |
| Tests | `tests/unit.test.js`, `tests/pages.test.js`, `tests/helpers/dom.js` (FileReader) |
| Docs | this file, `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, ADR 0014 |

## Tables and columns
| Change | Holds |
|---|---|
| `categories.parent_id`, `description`, `is_active` | two-level tree; `check_category_tree()` trigger refuses cycles and a third level; `category_path()` gives "Parent › Child" |
| `products.grade`, `origin`, `veg_type`, `shelf_life_days`, `storage_note` | details for the card and product page |
| `products.parent_product_id`, `variant_label` | pack sizes; `check_product_variant()` keeps it to one level |
| `products.sold_by_weight`, `weight_tolerance_pct` | loose-weight billing |
| `order_items.ordered_quantity`, `packed_at`, `packed_by` | `quantity` becomes what was billed; the order stays on record |
| `price_lists`, `price_list_items` | the price layer per city / sector (pricing:view / pricing:edit) |

## Business rules (each is one named function)
| Rule | Where |
|---|---|
| Two category levels, no cycles | `check_category_tree()` |
| A rule in force: product → category → parent category → global | `pricing_inputs()`; `ruleInForce()` + parent fallback in `pricing-rules.js` |
| The board's category filter includes sub-categories | `price_board()`; `categoryFamily()` in the catalogue |
| One level of pack sizes | `check_product_variant()` |
| The customer pays the most specific active price list: city + sector › sector › city › published | `price_list_for_restaurant()`, `customer_price()`; `listPrice()` mirrors the arithmetic |
| `place_order` charges `customer_price()`; the cart shows the same via `my_price_list()` | `place_order()` v5, `applyPriceList()` |
| Packed quantities: confirmed / packed orders only; weighed lines within tolerance, others only short; stock corrected; order re-totalled; fee as at order time | `set_packed_quantities()` |

## Not in this batch
Substitutes (Phase 2), contract / tender lists with dates and quantity slabs (Phase 2 — they will be
`price_list_items` with validity), favourites, document upload (batch 9), pick lists and a packing screen
(batch 5: `set_packed_quantities` is the function it will call).
