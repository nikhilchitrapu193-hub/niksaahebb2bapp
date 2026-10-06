# Fresh Supply

A B2B food-supply ordering platform modelled on Hyperpure: a public website with a
browsable catalogue, restaurants order from a wholesale catalogue with delivery slots
and credit, your team runs the warehouse (stock, suppliers, GRNs, wastage), confirms,
packs and dispatches orders with GST invoices, and delivery staff see their drops.
Three apps, each with its own login area. See [docs/hyperpure-feature-map.md](docs/hyperpure-feature-map.md)
for how Hyperpure works and what is built, simplified or on the roadmap.

* **No framework, no build step, no AI.** Plain HTML, CSS and ES modules. Open any file and read it.
* **Free to run.** Supabase free tier (Postgres + Auth + Storage) and any static host.
* **Secure by design.** The browser holds only a public key; Row Level Security and
  role-checking database functions are the real gatekeepers.
* **Easy to extend.** Everything lives in a predictable place — see "Where things live".

## Quick start

```bash
npm install        # only needed for the tests (jsdom)
npm start          # serves ./web at http://localhost:3000
```

Then open http://localhost:3000 (the public site), click **Register your restaurant**, and follow
[docs/runbook.md](docs/runbook.md) to promote your first account to admin.

## The three apps

| Area | Login page | App | Can do |
|---|---|---|---|
| Public | — | `/` | Landing page, live catalogue preview, FAQ, links to every login |
| Restaurant | `/restaurant/login.html` | `/restaurant/` | Catalogue, cart, delivery slot + COD/credit checkout, track/cancel/reorder, GST invoices, account |
| Admin | `/admin/login.html` | `/admin/` | Dashboard, orders (status, driver, payment, invoice), products (photos, GST, pricing), **inventory** (receive, adjust, wastage, ledger, suppliers), customers (approve, credit owed), team, company settings |
| Delivery | `/delivery/login.html` | `/delivery/` | Assigned orders by slot, map/call, cash to collect, start and complete deliveries |

Only restaurants can self-register; staff logins are created by invitation.
Details: [docs/roles.md](docs/roles.md).

## Where things live

```
web/
  index.html                    public landing page (marketing + catalogue preview)
  invoice.html, reset.html      printable GST invoice · password reset
  restaurant/ admin/ delivery/  login.html + index.html per area
  css/                          base.css (tokens) + components.css (UI parts)
  js/core/                      config, supabase client, auth, api, ui helpers, shell/router
  js/pages/<app>/               one module per screen
  vendor/supabase.js            vendored supabase-js (see vendor/README.md)
supabase/
  migrations/                   the database, in order (schema → security → functions)
  seed.sql                      sample categories and products
  tests/security_test.sql       role/permission regression test
scripts/dev-server.js           zero-dependency local server
tests/                          Node tests (unit + page smoke tests + static checks)
docs/                           architecture, ADRs, API, roles, deployment, runbook
```

## Documentation

* [Hyperpure feature map](docs/hyperpure-feature-map.md) — how Hyperpure works, what is built and what is roadmap
* [Architecture](docs/architecture.md) — diagrams and data flow
* [API reference](docs/api.md) — every database function and table
* [Roles & permissions](docs/roles.md)
* [Decision records (ADRs)](docs/adr/) — *why* it is built this way
* [Deployment](docs/deployment.md) · [Runbook](docs/runbook.md)
* [Testing](docs/testing.md) · [Contributing](docs/contributing.md)

## Roadmap

Phone-OTP login, online payments, multiple outlets per account, coupons, returns/credit notes,
supplier self-service app, batch/expiry tracking, CSV reports, notifications (email/WhatsApp), AI features. The architecture is ready for each — see
[ADR 0006](docs/adr/0006-google-login-roadmap.md) and [docs/contributing.md](docs/contributing.md#adding-ai-later).
