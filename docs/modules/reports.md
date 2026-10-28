# Module: Reports & dashboard

Phase 1, batch 10 in `docs/build-roadmap.md`. Shipped as migration 019
(`supabase/migrations/20261027000002_reports_dashboard.sql`).

## What it does, in one paragraph
**Reports** (admin menu, `reports:view`) answers "how much did we sell, to whom, of what" for any date range up to a
year, grouped by day, city, sector, customer, product or category, with GST and delivery fees split out and cancelled
orders counted separately; **Export CSV** (`reports:export`) opens in Excel. The **receivables trend** shows, week by
week, what was invoiced, what was collected, and what customers still owed at the end of the week (and how much of that
was overdue) — computed from the orders and allocations as they stood on that date, so it never drifts from Payments.
The **dashboard** gains a city filter for people who see several cities, a 14-day orders / revenue chart and an open
tickets tile. Customers can upload their **FSSAI licence and GST certificate** (Account → Documents, or staff on
Customers) to a private bucket; the Customers list shows which are on file before Approve. The public site gets
**content pages** (About, Terms, Privacy, Refund policy — add more) rendered by `page.html?slug=…` and linked from the
footer, and **SEO basics**: the home page title and description are edited under Settings → Website, with
`robots.txt` and `sitemap.xml` beside `index.html`. Everything is computed on request; nothing is pre-aggregated
(ADR 0024).

## Files
| Layer | Path |
|---|---|
| Database | `supabase/migrations/20261027000002_reports_dashboard.sql` |
| Security test | `supabase/tests/security_test.sql` T64 a–o |
| Core JS | `web/js/core/reports.js` (`reportTotals`, `reportColumns`, `barHeights`, `lastNDays`, `shortDate`), `config.js` (`REPORT_GROUPINGS`, `CUSTOMER_DOCUMENTS`, `documentBucket`, `MODULES.reports.nav`), `api.js` "Reports, documents, content pages" |
| Admin | `web/js/pages/admin/reports.js` (Reports: Sales · Receivables trend), `dashboard.js` (city filter, 14-day chart, tickets tile), `website.js` (Settings → Website: SEO + pages), `customers.js` (documents column, view / upload) |
| Customer | `web/js/pages/restaurant/account.js` (Documents), `main.js` (pending banner points to Documents) |
| Website | `web/page.html` + `web/js/pages/page.js` (`renderBody`, `fillFooter`), `web/robots.txt`, `web/sitemap.xml`, `index.html` footer "Company" links, `landing.js` (SEO title / description from settings) |
| Tests | `tests/unit.test.js` (report helpers, `renderBody`), `tests/pages.test.js` (reports screen + CSV, picker no access, dashboard filter + chart, website editor, public page + footer, account document upload) |
| Decision record | ADR 0024 |

## Functions
| Function | Who | What |
|---|---|---|
| `sales_report(from, to, group_by, city_id)` | `reports:view` | Rows `{key, label, orders, quantity, subtotal, tax, delivery_fee, total, cancelled}` for orders created in the range (India dates, inclusive), in scope, optionally one city. Product / category groupings carry quantity and the line total (before GST); the others split subtotal / GST / delivery fee. Range ≤ 370 days. |
| `receivables_trend(weeks, city_id)` | `reports:view` | One row per week ending Sunday: `invoiced` (delivered that week), `collected` (allocations that week), `open` and `overdue` as at the week's end. 1–52 weeks. |
| `admin_dashboard_stats(city_id)` | `dashboard:view` | The batch-8 numbers narrowed to a city (null = whole scope) plus `daily_14d` `[{day, orders, revenue}]` and `open_tickets`. The zero-argument version stays for older callers. |
| `set_customer_document(restaurant_id, kind, path)` | the customer (own) or `customers:edit` in scope | Records `fssai_doc_path` / `gst_doc_path`; the path must start with the customer's id. |
| `support_channels()` *(v2)* | anon + authenticated | Now also `address`, `gstin`, `fssai`, `seo_title`, `seo_description` for the public pages' footer and `<title>`. |

Storage bucket `customer-documents` (private, 8 MB, PDF / JPEG / PNG / WebP): the customer reads and writes
`<restaurant id>/…`; `customers:view` reads, `customers:edit` writes any. Table `content_pages` (`slug`, `title`,
`body`, `is_published`, `show_in_footer`, `sort_order`): anon reads published; `settings:edit` writes; audited.
`company_settings.seo_title / seo_description`.

## Who may do what
| Action | Who |
|---|---|
| Open Reports, run either report | `reports:view` (seeded: super admin, city manager, pricing manager, finance) |
| Export CSV | `reports:export` |
| Filter the dashboard by city | anyone with `dashboard:view` and no city scope of their own (a city manager already sees one city) |
| Upload / view own documents | the customer |
| View / upload a customer's documents | `customers:view` / `customers:edit` |
| Edit content pages and SEO | `settings:edit` |

## Notes
* Reports are built from `orders`, `order_items` and `payment_allocations` on request. At Phase 1 volumes (hundreds of
  orders a day) a year-long report answers in well under a second; if that changes, the first step is an index on
  `orders (created_at)` and the second a nightly `daily_sales` table — not a change to the screens.
* "Sales" is order value at creation (what was ordered, net of later edits because the order row is updated in place);
  the finance batch in Phase 2 (P2-6) adds delivered / invoiced views with GST summaries for returns.
* The sitemap is a static file: add a `<url>` when you publish a new page. `robots.txt` keeps crawlers out of the apps.
