# Patch guide — Phase 1, Batch 3: Catalogue + (15 Oct 2026)

What this batch adds (build list sections 3 and 4, Phase 1): two-level category tree (pricing rules inherit
down it) · pack-size variants (one card, a pack picker) · grade, origin, veg / non-veg, shelf life, storage
note and a product page · loose-weight items billed on the packed weight (with a tolerance) and short
supply · catalogue sort and filters · bulk product upload from CSV · price lists per city and / or sector.
Full description: `docs/modules/catalogue.md`, decision record ADR 0014.

Tested: `npm test` 76/76 · `security_test.sql` 145/145 PASS on a local Postgres 16 built from the migrations
· every new and changed screen rendered in headless Chromium without errors.

**Status on the live project (bzxygscjhvcwahwqgqin), 15 Oct 2026:** migration 010 is applied — the category
tree is seeded (40 categories, 25 of them sub-categories), the price-list tables, `set_packed_quantities`,
`customer_price` / `my_price_list` and `place_order` v5 are live. No product data was changed live; the
sample details in `seed.sql` (sub-categories for the sample products, grades, loose-weight flags, the 25 kg
rice bag) are for a fresh install — run that block in the SQL editor if you want them on the live catalogue.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)

1. Unzip `fresh-supply-catalogue-batch.zip` into `C:\Projects\fresh-supply\` — 38 files (8 new, 30 modified),
   in their folders. Say **yes** to replacing.
2. `npm test` → `# pass 76`.
3. `git add -A` → `git commit -m "Phase 1 batch 3: catalogue tree, variants, loose weight, price lists"` → `git push`.
4. Database: nothing to do — migration 010 is already live.
5. `npm start`, sign in as admin:
   - **Products → Categories**: the tree is there; move products into sub-categories as you like.
   - **Products → Edit**: grade, origin, veg / non-veg, shelf life, storage, *Pack size of*, *Sold by weight*.
   - **Products → Upload CSV** for bulk changes.
   - **Pricing → Price lists**: e.g. "Hotels −3 %" for the hotel sector.
   - **Orders → a confirmed order**: the *Packed* column; type actual weights, *Save packed quantities*.
   - Sign in as a customer: sort / filter, sub-category chips, pack picker, product page, "Your price".

## Files — NEW (8)

| Path | What it is |
|---|---|
| `supabase/migrations/20261015000005_catalogue_plus.sql` | **NEW** — migration 010 (already live) |
| `web/js/core/catalogue.js` | **NEW** — pure helpers: category tree / options / family, variant grouping, catalogue filters and sort, price-list merge |
| `web/js/core/csv-import.js` | **NEW** — `csvToProducts()` for the bulk upload |
| `web/js/pages/admin/price-lists.js` | **NEW** — Pricing → Price lists |
| `web/js/pages/restaurant/product.js` | **NEW** — the product page (`#product/<id>`) |
| `docs/modules/catalogue.md` | **NEW** — the module README |
| `docs/adr/0014-variants-as-products-price-lists-as-a-layer.md` | **NEW** — decision record |
| `docs/patches/2026-10-15-catalogue-batch.md` | **NEW** — this guide |

## Files — MODIFIED (30)

| Path | What changed |
|---|---|
| `supabase/seed.sql` | sample sub-categories, grades / origin, veg type, loose-weight flags, the 25 kg rice bag |
| `supabase/tests/security_test.sql` | T40–T43 (tree, inheritance, variants, price lists, packing); product counts 25 → 26; restaurant A re-activated before T31 so that check is real — 145 checks |
| `web/js/core/api.js` | `saveProduct` new fields; `saveCategory` parent; `upsertProducts`; price-list wrappers; `getMyPriceList`; `setPackedQuantities` |
| `web/js/core/config.js` | `VEG_TYPES`, `CATALOGUE_SORTS` |
| `web/js/core/csv.js` | `readTextFile()` (FileReader; `File.text()` is not everywhere) |
| `web/js/core/shell.js` | prefix routes (`'#product/'` → parameter) |
| `web/js/pages/admin/products.js` | tree select, details, pack-size parent, loose weight, CSV upload, category manager with parent |
| `web/js/pages/admin/orders.js` | Packed column + *Save packed quantities* on confirmed / packed orders; ordered vs billed; HSN per line |
| `web/js/pages/admin/pricing-rules.js` | sub-category cards inherit the parent rule; paths |
| `web/js/pages/admin/price-board.js` | category filter shows the tree; Price lists tab |
| `web/js/pages/admin/benchmarks.js` | `readTextFile` |
| `web/js/pages/admin/main.js` | `#price-lists` route |
| `web/js/pages/restaurant/catalogue.js` | sort, brand / veg / in-stock filters, sub-category chips, pack picker, "Your price", product links |
| `web/js/pages/restaurant/main.js` | applies `my_price_list()`; `#product/` route |
| `web/js/pages/restaurant/orders.js`, `web/js/pages/invoice.js` | "ordered 5, billed 5.2" |
| `web/js/pages/landing.js` | top-level tiles with sub-category counts; packs not featured twice |
| `web/css/components.css` | product page, pack picker, sub-category rule cards |
| `tests/helpers/dom.js` | `FileReader` / `File` globals |
| `tests/unit.test.js` | tree, filters, variants, price-list merge, CSV import, `listPrice` |
| `tests/pages.test.js` | 7 new screen tests; rules test expects the sub-category card |
| `AGENTS.md`, `CLAUDE.md` | rule 16 (a pack size is a product; a customer's price is `customer_price()`); file map |
| `docs/api.md`, `docs/roles.md`, `docs/runbook.md`, `docs/testing.md`, `docs/adr/README.md`, `docs/build-roadmap.md`, `README.md` | updated |

## Behaviour changes to know about

- `place_order` now charges `customer_price()`: the published price unless a price list covers the customer.
- Order lines carry `ordered_quantity`; `quantity` is what was packed and billed. Only confirmed / packed
  orders can be packed; a weighed line must be within the product's tolerance, other lines may only be short.
- A product with pack sizes shows as one card; each pack has its own stock and price (and HSN, which the
  product page inherits from the main product when the pack has none).
- The price board's category filter and the pricing rules follow the tree (a sub-category without its own
  rule uses its parent's).
- Known shortcuts: a zero packed quantity is refused (removing a line is an order edit, batch 6); contract
  lists with dates and quantity slabs come in Phase 2 on top of `price_list_items`.
