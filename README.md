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
| Customer | `/restaurant/login.html` | `/restaurant/` | Catalogue for their city, cart with minimum-order / delivery-fee / PO rules, delivery slot + COD/credit checkout, track/cancel/reorder, GST invoices, account (city, pin code) |
| Admin | `/admin/login.html` | `/admin/` | Dashboard, orders (filters, status, driver, payment, invoice, export), products (photos, GST, per-city listing), **inventory per warehouse** (receive, adjust, wastage, ledger, suppliers), customers (sector, terms, approve), team (team roles, city / warehouse scope), settings (company, **cities & warehouses & pin codes**, **sectors & terms**, **roles & permissions**), **audit log** |
| Delivery | `/delivery/login.html` | `/delivery/` | Assigned orders by slot, map/call, cash to collect, start and complete deliveries |

Only customers can self-register; staff logins are created by invitation and get a team role
(super admin, city manager, picker, …) whose permissions the owner ticks on a settings screen.
Details: [docs/roles.md](docs/roles.md).

## Where things live

```
web/
  index.html                    public landing page (marketing + catalogue preview)
  invoice.html, reset.html      printable GST invoice · password reset
  restaurant/ admin/ delivery/  login.html + index.html per area
  css/                          base.css (tokens) + components.css (UI parts)
  js/core/                      config, supabase client, auth, api, ui helpers, shell/router, permissions, csv
  js/pages/<app>/               one module per screen
  vendor/supabase.js            vendored supabase-js (see vendor/README.md)
supabase/
  migrations/                   the database, in order (schema → security → functions → inventory → foundation)
  seed.sql                      sample categories and products
  tests/security_test.sql       role/permission regression test (85 checks)
  tests/local_postgres_stub.sql run the same test on a plain local Postgres
scripts/dev-server.js           zero-dependency local server
tests/                          Node tests (unit + page smoke tests + static checks)
docs/                           architecture, ADRs, API, roles, deployment, runbook, code rules, build roadmap, modules/
.cursor/                        code rules + fs-feature / fs-review / fs-security-check skills for coding agents
```

## Documentation

* [Hyperpure feature map](docs/hyperpure-feature-map.md) — how Hyperpure works, what is built and what is roadmap
* [Build roadmap](docs/build-roadmap.md) — the batches still to build, in order, with the files each one adds
* [Code rules](docs/code-rules.md) — how to write code any developer can read (and the agent skills that enforce it)
* [Architecture](docs/architecture.md) — diagrams and data flow
* [API reference](docs/api.md) — every database function and table
* [Roles & permissions](docs/roles.md)
* [Decision records (ADRs)](docs/adr/) — *why* it is built this way
* [Deployment](docs/deployment.md) · [Runbook](docs/runbook.md)
* [Testing](docs/testing.md) · [Contributing](docs/contributing.md)

## Roadmap

Batch 1 of Phase 1 (cities, warehouses, sectors, roles, audit) is in. Next: the pricing engine, catalogue
extensions, procurement, fulfilment, payments and credit, notifications, reports — see
[docs/build-roadmap.md](docs/build-roadmap.md). AI stays out of the product by design
([docs/contributing.md](docs/contributing.md#adding-ai-later)).
