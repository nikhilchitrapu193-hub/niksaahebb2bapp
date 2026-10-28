# Patch guide — Batch 10: Reports & dashboard (27 Oct 2026)

The last batch of Phase 1. Apply **after** the batch-9 patch (`2026-10-27-notifications-support-batch.md`): this one
builds on it (open-tickets tile, support channels in the footer).

**What's new** (migration 019 — **already applied live**):
* **Reports** menu (for roles with `reports:view`: super admin, city manager, pricing manager, finance):
  **Sales** for any date range, grouped by day / city / sector / customer / product / category, GST and delivery fees
  split out, cancelled orders counted separately, **Export CSV**; **Receivables trend** by week — invoiced, collected,
  open and overdue as at each week's end, with a bar chart.
* **Dashboard**: a city filter (for people who see several cities), a 14-day orders / revenue chart, an *Open tickets*
  tile.
* **Customer documents**: customers upload their FSSAI licence and GST certificate under Account → Documents (the
  "awaiting approval" banner asks them to); Customers shows *FSSAI ✓ / GST ✓* with a view link and lets staff upload
  one received on WhatsApp. Private bucket; the customer sees only their own folder.
* **Website pages**: About, Terms, Privacy and Refund policy (seeded, editable, add more) at `page.html?slug=…`,
  linked from the footer of every public page; the footer also shows your company details from Settings → Company.
* **SEO basics**: home page title / description under Settings → Website; `robots.txt` (keeps the apps out of search)
  and `sitemap.xml` beside `index.html` — replace `YOUR-DOMAIN` in both once the site has its address.
* ADR 0024: reports are computed on request from the real tables, never stored as aggregates (they can't drift from
  Payments; a nightly summary table is the escape hatch if volume ever demands it).

Tested: `npm test` **140/140** · `security_test.sql` **278/278** (15 new T64 checks) on a clean local Postgres ·
10 screens rendered in headless Chromium with no console errors (dashboard with chart + filter, sales by day / by
product, trend, website editor + page editor, customers with documents, account documents, public page, home page).

**Live project (bzxygscjhvcwahwqgqin):** migration 019 applied (4 pages seeded, `customer-documents` bucket,
`sales_report` / `receivables_trend` / `set_customer_document`, `admin_dashboard_stats(p_city_id)` alongside the old
one). No function to deploy.

## How to apply (Cursor, Windows, repo at `C:\Projects\fresh-supply`, on `main`)
1. Make sure the batch-9 zip is already in. Unzip `fresh-supply-batch10-reports.zip` into the repo root — **35 files
   (10 new, 25 modified)**. Say **yes** to replacing.
2. `npm test` → `# pass 140`.
3. `git add -A` → `git commit -m "Batch 10: reports & dashboard, documents, website pages (019)"` → `git push origin main`.
4. Database: **nothing to run** — 019 is live.
5. Edit `web/robots.txt` and `web/sitemap.xml`: replace `YOUR-DOMAIN`. Then Admin → Settings → Website: read the four
   seeded pages and change anything that is not true for you (company name, cities, refund days).
6. Try it: Reports → Sales (last 30 days by day) → change the grouping → Export CSV. Reports → Receivables trend.
   Dashboard → pick a city (only shows when you have more than one). Open `page.html?slug=about` on the site.

## Files — NEW (11)
| Path | What it is |
|---|---|
| `supabase/migrations/20261027000002_reports_dashboard.sql` | migration 019 (applied live) |
| `web/js/core/reports.js` | `reportTotals`, `reportColumns`, `barHeights`, `lastNDays`, `shortDate` (unit-tested) |
| `web/js/pages/admin/reports.js` | Reports: Sales · Receivables trend, CSV |
| `web/js/pages/admin/website.js` | Settings → Website: SEO + content pages |
| `web/page.html`, `web/js/pages/page.js` | public content page (`renderBody`, shared `fillFooter`) |
| `web/robots.txt`, `web/sitemap.xml` | search-engine files (replace `YOUR-DOMAIN`) |
| `docs/modules/reports.md` | module doc |
| `docs/adr/0024-reports-computed-not-stored.md` | decision record |
| `docs/patches/2026-10-27-reports-dashboard-batch.md` | this guide |

## Files — MODIFIED (25)
| Path | What changed |
|---|---|
| `web/js/core/config.js` | `documentBucket`, `MODULES.reports.nav = '#reports'`, `REPORT_GROUPINGS`, `CUSTOMER_DOCUMENTS` |
| `web/js/core/api.js` | `getDashboardStats(cityId)`; "Reports, documents, content pages" section |
| `web/js/pages/admin/main.js` | routes `#reports`, `#website` |
| `web/js/pages/admin/settings.js` | Website tab |
| `web/js/pages/admin/dashboard.js` | city filter, 14-day chart, open-tickets tile |
| `web/js/pages/admin/customers.js` | documents column: view / upload |
| `web/js/pages/restaurant/account.js` | Documents section |
| `web/js/pages/restaurant/main.js` | pending banner points to Documents |
| `web/js/pages/landing.js`, `web/index.html` | footer "Company" links + company details from the database; SEO title / description from settings |
| `web/css/components.css` | `.bars` chart, header stays on one line with 13 modules |
| `supabase/tests/security_test.sql` | T64 a–o (278 checks) |
| `supabase/tests/local_postgres_stub.sql` | test-only: `storage.foldername()`, grants on `storage.objects` |
| `tests/helpers/fake-supabase.js` | records storage uploads |
| `tests/unit.test.js`, `tests/pages.test.js`, `tests/static.test.js` | 3 unit + 6 page tests; nav counts; `?slug=` references |
| `docs/runbook.md` | Reports, Customer documents, Website pages & SEO, troubleshooting rows |
| `docs/deployment.md` | §8 Search engines |
| `docs/api.md`, `docs/roles.md`, `docs/testing.md`, `docs/build-roadmap.md` (Phase 1 complete), `docs/adr/README.md`, `README.md` | new functions, `reports:*` permissions, counts, batch 10 ✅ |
