# Build roadmap

The complete feature list (about 170 features in 10 modules) is in the project document
*Fresh Supply — Complete Build List*. This file turns it into build batches that a developer (or an
agent with `/fs-feature`) can pick up one at a time. Each batch ships the usual set: one migration,
security-test checks, api.js wrappers, screens, page tests, docs, and an ADR where a choice was made.

Status: ✅ shipped · 🔧 in progress · ⬜ not started

## Phase 1 — launch in Vizag for restaurants

| # | Batch | Status | Migration | Main new files |
|---|---|---|---|---|
| 1 | **Foundation**: cities, warehouses, pin-code zones, stock per warehouse, sectors & terms (MOV, delivery fee, PO rule), team roles + permission matrix + scope, audit log, CSV export, pin-code check on the site | ✅ | 006 | `docs/modules/foundation.md` lists them |
| 2 | **Pricing engine, part 1**: HSN codes, pack size / unit, `pricing_rules` per category, `product_pricing` overrides, benchmark sources & prices (manual + CSV), price history, weighted-average cost view, `compute_price` / `apply_prices`, shared `pricing.js`, **Daily price board**, **Pricing rules**, **Benchmarks** screens, margin guard, rounding, scheduled price changes | ⬜ | 007 | `supabase/migrations/20261101000001_pricing_engine.sql`, `web/js/core/pricing.js`, `web/js/pages/admin/price-board.js`, `pricing-rules.js`, `benchmarks.js`, `docs/modules/pricing.md`, ADR 0013 |
| 3 | **Catalogue +**: full category tree (parent_id), variants / pack sizes, grades & origin, loose-weight items billed on actual weight, sort & filters, bulk product upload (CSV), product page details | ⬜ | 008 | `web/js/pages/restaurant/product.js`, `web/js/core/csv-import.js`, `docs/modules/catalogue.md` |
| 4 | **Procurement**: supplier rate cards, buying list (tomorrow's orders − stock), purchase orders (open / part-received / closed), GRN against PO with quality check (accepted / rejected / short), mandi cash purchase with photo | ⬜ | 009 | `web/js/pages/admin/purchase-orders.js`, `buying-list.js`, `grn.js`, `docs/modules/procurement.md` |
| 5 | **Fulfilment & delivery**: batches & expiry (FEFO), near-expiry alerts, pick lists per slot, packing with actual weights and short items, vehicles, routes / trip sheets, proof of delivery (photo, OTP), doorstep returns, driver cash collection and settlement, delivery charge rules, logistics-partner login | ⬜ | 010 | `web/js/pages/admin/picking.js`, `trips.js`, `web/js/pages/delivery/*` updates, `docs/modules/fulfilment.md` |
| 6 | **Orders +**: edit before cut-off, slot capacity & cut-off times, short-supply handling, order on behalf of a customer, cancellation rules, report an issue → credit note | ⬜ | 011 | `web/js/pages/admin/order-edit.js`, `web/js/pages/restaurant/issues.js` |
| 7 | **Payments & credit**: Razorpay online payments (Edge Function + webhook), credit limit & days, ageing report, record payments (cheque / bank / UPI), credit & debit notes, monthly statements, receivables reports, HSN on invoices | ⬜ | 012 | `supabase/functions/razorpay-webhook/`, `web/js/pages/admin/receivables.js`, `web/js/pages/restaurant/payments.js` |
| 8 | **Notifications & support**: email provider (Resend / Brevo), SMS + phone-OTP login (MSG91), support tickets, help centre, call / WhatsApp buttons, maps pin at sign-up, backups & monitoring | ⬜ | 013 | `supabase/functions/send-sms/`, `web/js/pages/admin/tickets.js` |
| 9 | **Reports & dashboard**: sales by day / city / sector / customer / product, receivables, dashboard filtered by city, document upload at sign-up, content pages + SEO basics | ⬜ | 014 | `web/js/pages/admin/reports.js`, `supabase/storage` bucket for documents |

Phase 1 gate: every batch above used daily by the Vizag team before Phase 2 starts.

## Phase 2 — institutions, suppliers, full warehouse, Fleetbase

Sector home pages and sign-up per sector · customer-side users (owner / outlet manager / approver) ·
multiple outlets · approval before dispatch · standing orders · bulk order upload · coupons ·
spend reports · contract / tender rates and quantity slabs · price-change approval · quote builder,
delivery-cost and credit-cost calculators · supplier onboarding, portal, three-way match, payments ·
storage zones & bins, cycle counts, transfers, repacking, labels, barcode scanning, returns to stock,
stock valuation · Fleetbase self-hosted with the Indian adaptations (status mapping, webhooks, POD
sync, UPI at the door, MSG91, WhatsApp) · GST reports, Tally export, profit per order · leads
pipeline, sector settings, content management · PWA.

Decision to make before Phase 2: keep "no framework" or adopt a light one (ADR 0003 revisit).

## Phase 3 — several cities

Legal entity per state (GSTIN, invoice series), city launch checklist, small retailers sector, ratings,
referrals, menu costing, supplier scorecards, farmer sourcing, cold-chain logs, live tracking, e-invoicing
and e-way bills, late-payment interest, what-if simulator, automatic Agmarknet benchmarks, SSO into
Fleetbase, compliance threshold watch.

## How to pick up a batch

1. Read the batch row above and the matching rows in the Complete Build List.
2. Run `/fs-feature` (or follow `.cursor/skills/fs-feature/SKILL.md` by hand).
3. Create `docs/modules/<module>.md` from the foundation one as a template.
4. Update the status column here in the same change.
