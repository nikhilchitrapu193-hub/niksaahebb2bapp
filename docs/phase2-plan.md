# Batches 9–10 and Phase 2 — the build plan (27 Oct 2026)

The owner asked for batches 9 and 10 and the whole of Phase 2 in one go. This file is the
sequence, written before the first line of code so that each batch can be picked up, reviewed
and applied on its own. Every batch ships the usual set: one migration (applied live when the
Supabase tool allows, else from the SQL editor), security-test checks, `api.js` wrappers,
screens, page tests, docs, an ADR where a choice was made, and a patch zip + guide.

**Framework decision (ADR 0003 revisit, required before Phase 2):** stay with no framework.
Seventeen migrations and ~40 screens follow one pattern (`html```, `api.js`, `on()`); a
framework now would be a rewrite for no feature gain, and the owner's rule is "any developer
can read it". Recorded in ADR 0022.

| # | Batch | Migration | Contents |
|---|---|---|---|
| 9 | **Notifications & support** | 018 | `notifications` log + `notification_settings` per sector/event; an **SMS gateway** behind one provider interface — **httpSMS** (your own Android phone + SIM, zero per-message cost) first, MSG91 as a config swap later; **email via SMTP** (Resend/Brevo) for confirmation, reset, invoices; order-status and payment-due messages fired by database triggers into an outbox the `send-notifications` Edge Function drains; **support tickets** (customer raises, staff replies, statuses); **help centre** (FAQ pages the admin edits); **call / WhatsApp buttons** on every customer and order; **map pin at sign-up** (lat/lng + "use my location"); **backups & monitoring** runbook; **payment reminders** (due tomorrow / overdue, with a per-sector switch). Phone-OTP sign-in stays out (ADR 0023: email + password + backups cover Phase 1; SIM gateways are not reliable enough for the login path). |
| 10 | **Reports & dashboard** | 019 | `sales_report()` by day / city / sector / customer / product with date range and CSV; **receivables trend** (open and overdue per week); **dashboard filtered by city**; **document upload at sign-up** (FSSAI / GST certificate to a private bucket, visible on Customers → Approve); **content pages** (About, Terms, Privacy, Refund policy — admin-edited, rendered on the public site) + **SEO basics** (titles, descriptions, sitemap, robots). |
| P2-1 | **Customer organisation** | 020 | **Multiple outlets** per customer account (each with its own address, pin code, warehouse, slot); **customer-side users** — owner / outlet manager / approver — invited by the owner; **approval before dispatch** for sectors that need it (`needs_order_approval`: an approver signs off before the kitchen packs); **sector home pages** on the public site and sign-up links per sector. |
| P2-2 | **Ordering +** | 021 | **Standing orders** (weekly / daily templates that place themselves at the cut-off); **bulk order upload** (CSV of SKU, qty); **coupons** (code, % or ₹ off, min order, validity, per-sector, once per customer); **spend reports** for the customer (by month / product); **quote builder** for staff (a priced quote a customer can accept into an order); **delivery-cost and credit-cost calculators** on the public site. |
| P2-3 | **Contract pricing & price approval** | 022 | **Contract / tender rates** per customer with validity (beat price lists); **quantity slabs** (cheaper per unit above N); **price-change approval**: a pricing manager proposes, a super admin / finance approves before `apply_prices` publishes (for sectors or amounts over a threshold). |
| P2-4 | **Suppliers** | 023 | **Supplier onboarding** (GSTIN, bank, FSSAI, documents) and a **supplier login role** with its own app: see POs, acknowledge, upload invoices; **three-way match** (PO ↔ GRN ↔ supplier invoice) with variance flags; **supplier payments** (payables ledger, mirrors receivables). |
| P2-5 | **Warehouse +** | 024 | **Storage zones & bins** (product default bin, put-away on GRN); **cycle counts** (count sheet → adjustments); **transfers** between warehouses (dispatch / receive); **repacking** (break a 25 kg bag into 1 kg packs: stock moves between variants); **labels** (printable product / bin / batch labels with barcodes); **barcode scanning** (camera via the browser's BarcodeDetector where available, keyboard scanner always) on receive, pick and count; **stock valuation** report (quantity × weighted cost). |
| P2-6 | **Finance reports** | 025 | **GST reports** (GSTR-1 B2B/B2C summaries by rate and month, CSV); **Tally export** (XML vouchers for sales, receipts, purchases); **profit per order** (sale − snapshotted landed cost − delivery cost) and per product / customer / month. |
| P2-7 | **Growth & web** | 026 | **Leads pipeline** (enquiry → contacted → trial → customer; from the public site's forms and the sector pages); **sector settings** (per-sector home page copy, default terms already exist); **content management** (edit public pages and the FAQ from the admin); **PWA** (manifest, service worker for the customer and delivery apps, install prompt). |
| P2-8 | **Fleetbase integration** | 027 | A **logistics adapter** behind one interface (`fulfilment` keeps working with no adapter): push trips/orders to Fleetbase, receive status + POD by webhook (`fleetbase-webhook` Edge Function), the Indian adaptations (status mapping, UPI-at-door cash reconciliation into `driver_cash`, MSG91/WhatsApp hooks via batch 9's notifications). Fleetbase itself is self-hosted by the owner (Docker); the guide covers it. |

Apply order is strict (each migration builds on the one before). Each batch's guide says whether
the Supabase tool applied its migration or it must go through the SQL editor.

Out of scope here (Phase 3 stays Phase 3): legal entity per state, e-invoicing / e-way bills,
late-payment interest, live tracking, ratings, referrals, farmer sourcing.
