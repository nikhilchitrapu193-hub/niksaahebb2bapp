# 0014 — Pack sizes are products; price lists are a layer over the published price
**Status:** Accepted

**Context.** The build list asks for one product sold as 1 kg, 5 kg and 25 kg (each with its own price and
stock), and for separate price lists per city and sector with contract lists later. Both could have been
modelled as new tables under `products` (a `product_variants` table; a `prices` table keyed by list).
Either would have touched every screen and function that reads `products.price` or reserves stock.

**Decision.**
1. **A pack size is a product row** with `parent_product_id` and `variant_label`. It has its own SKU, price,
   HSN, pack size and warehouse stock, so orders, the ledger, the price board, audit and reports need no
   change. The catalogue groups the rows into one card (`groupVariants()`); one level only.
2. **Price lists are a layer, not a second price.** `products.price` stays the single published price that
   the board computes and the public site shows. A `price_lists` row (city and / or sector) adds a %
   adjustment and `price_list_items` fixed prices; `customer_price(product, restaurant)` resolves the most
   specific active list. `place_order` charges it; `my_price_list()` hands the customer app the differences
   so the cart and the order agree.
3. **Loose-weight billing changes `quantity`, keeps `ordered_quantity`.** `set_packed_quantities()` writes
   the actual quantity, re-totals the order and moves the stock difference, within the product's tolerance.
   A zero quantity is an order edit (batch 6), not a weight.

**Consequences.**
+ No new price or stock paths; the 145 existing security checks keep covering orders and stock.
+ Contract lists (Phase 2) become `price_list_items` with validity dates and quantity slabs — an extension,
  not a redesign.
− A customer's price is not in `products`, so any screen that shows a price to a customer must apply
  `my_price_list()` (today: catalogue, product page, cart). `landing.js` shows the published price only.
− A product with variants cannot itself become a pack of another; one level is enough for a food catalogue.
