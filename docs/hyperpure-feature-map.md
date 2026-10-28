# How Hyperpure works — and what Fresh Supply builds from it

Hyperpure (Zomato / Eternal) is a B2B supply platform: it buys from farmers, mills and brands,
holds stock in its own warehouses, and sells to FSSAI-licensed restaurants, cloud kitchens, hotels
and caterers with next-day or same-day delivery. This document lists every part of that business
we could identify, then maps each one to our build: **Built**, **Built (simplified)**, or **Roadmap**.

## 1. Public website (hyperpure.com)

| Hyperpure | Fresh Supply |
|---|---|
| Marketing landing page: hero banners (kitchen supplies, menu innovations, supply-chain solutions, bakery) | **Built** — `web/index.html` landing page with your own copy |
| Trust numbers (130+ cities, 1 lakh+ partners, 1.1 crore+ orders, 1000+ brands) | **Built** — editable stat tiles |
| City selector ("delivered instantly across Delhi…") | Roadmap — single service area for now |
| Public, browsable catalogue by category with "Best rate" strike-through pricing, ratings | **Built** — public catalogue preview (prices and "market price" strike-through; ratings roadmap) |
| Two delivery models: Wholesale (next-day, scheduled) and Express (same-day) | **Built** — delivery date + slot at checkout; express flagged as a slot type |
| Testimonials carousel, FAQ (orders, refunds, account, payment), footer with CIN, FSSAI, GST details | **Built** — static sections you edit in one file |
| Separate "Login / Sign up" for partners (phone + OTP) | **Built (simplified)** — separate login pages for restaurants, admin and delivery staff; email + password. Phone OTP needs a paid SMS provider → Roadmap |
| Blog, sustainability page, supplier code of conduct | Roadmap (static pages) |

## 2. Restaurant (buyer) app

| Hyperpure | Fresh Supply |
|---|---|
| Onboarding: register outlet, FSSAI licence, GSTIN; approval before ordering | **Built** — registration with GSTIN/FSSAI, admin approval |
| Multiple outlets under one account, per-outlet delivery slots | Roadmap — one outlet per account today (schema note in ADR 0007) |
| Catalogue: categories, sub-categories, brands, search, filters, sort | **Built** — categories, brands, search; sort/filters roadmap |
| Product page: unit, pack size, rating, market price vs best rate, stock limits for bulk | **Built** — unit, min order qty, market price, live stock check at order time |
| Cart split by delivery slot, scheduled delivery, subscriptions | **Built (simplified)** — one slot per order; subscriptions roadmap |
| Checkout: delivery date, slot, payment method (pay now / pay later credit / wallet), voice instructions | **Built** — date, slot, Cash on delivery or Credit (pay later, blocked when overdue / over the limit); notes field. Online payment via Razorpay (switch on with keys). Wallet and voice notes roadmap |
| Coupons corner, offers, loyalty, referrals | Roadmap |
| Order tracking (placed → confirmed → packed → out for delivery → delivered) | **Built** |
| Reorder from past orders | **Built** |
| GST invoice per order | **Built** — printable invoice page with company and buyer GSTIN, per-line GST |
| Returns / refunds, ratings, chat support | **Built** (batch 6) — report an issue → credit note; doorstep returns (batch 5). Ratings / chat are roadmap |
| Credit terms and interest on overdue dues | **Built** — credit days + credit limit per sector / customer, due dates, overdue block, receipts, credit / debit notes, ageing, statements, customer Payments page. Interest roadmap |

## 3. Operations / warehouse (what Hyperpure runs internally)

| Hyperpure | Fresh Supply |
|---|---|
| Procurement from suppliers via purchase orders; Goods Received Notes (GRN) | **Built** (batch 4) — supplier rate cards, buying list, purchase orders (approve, print, WhatsApp, part-receive, short-close), GRN with quality check, mandi cash purchases with bill photo |
| Warehouse inventory with quantity on hand, low-stock alerts | **Built** — stock per product, low-stock threshold, low-stock banner |
| Stock adjustments: wastage, damage, counts | **Built** — adjustments with reason and note; full movement ledger |
| Quality checks, cold chain, batch/expiry tracking | Roadmap — batch/expiry columns are the next step in the ledger |
| Order picking/packing, dispatch, fleet assignment | **Built** (batch 5) — pick list, trip sheets (driver + vehicle), dispatch with a POD OTP, proof of delivery, doorstep returns, driver cash settlement |
| Seller (supplier) app: POs, GRNs, invoices, payments | Roadmap — suppliers managed by admin for now |
| Private-label products ("Hyperpure – Walnut Brownie") | **Built** — brand field; your own brand is just a brand |
| Pricing: market rate tracking, "best rate" | **Built (simplified)** — market price vs your price |
| Culinary development centre, custom packaging | Out of scope (services, not software) |

## 4. Admin back office

| Need | Fresh Supply |
|---|---|
| Dashboard: orders, revenue, pending approvals, top products | **Built** |
| Orders: filter, detail, status, driver, invoice, record payment | **Built** |
| Products: CRUD, photos, brand, GST rate, market price, stock | **Built** |
| Inventory: receive, adjust, ledger, suppliers | **Built** |
| Customers: approve/suspend, outstanding credit, credit limit | **Built** |
| Receivables: ageing, receipts, void, statements | **Built** — Payments (migration 015) |
| Launch control: which sectors are live, simple vs advanced pricing and stock | **Built** — Settings → Launch (migration 014) |
| Team: roles and deactivation | **Built** |
| Company settings (name, address, GSTIN, FSSAI, phone for invoices) | **Built** |
| Reports/exports (CSV) | Roadmap |

## Sources
* [hyperpure.com](https://www.hyperpure.com/) — landing page, categories, delivery models, FAQ
* [Hyperpure on the App Store](https://apps.apple.com/in/app/hyperpure/id1203646221) — slots, outlets, voice instructions, coupons
* [Hyperpure Seller app](https://play.google.com/store/apps/details?id=com.hyperpure.seller&hl=en) — POs, GRNs, invoices
* [UX case study of the Hyperpure buyer app](https://shweta-bendre6.medium.com/building-a-farm-to-folk-system-19e057e62b6f) — onboarding, cart by slot, pay later, tracking
* [Inside Zomato's Hyperpure (Inc42)](https://inc42.com/features/inside-zomatos-hyperpure-the-battle-to-control-indias-54-bn-restaurant-economy/) — sourcing, warehouses, credit terms
* [Decoding Hyperpure (Zomato blog)](https://blog.zomato.com/decoding-hyperpure)
