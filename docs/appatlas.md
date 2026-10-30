# AppAtlas — the app's own knowledge base

AppAtlas reads this repository (and a snapshot of the live database) and builds one website that explains
every screen twice: in plain words for the people running the business (**Admin mode**) and in code terms
for developers (**Developer mode**). It is deterministic: no AI, no network and no token use when it runs.
The same repository always produces the same output. Why it is built this way: [ADR 0026](adr/0026-appatlas-deterministic-knowledge-base.md).

```bash
npm run atlas            # scan + write appatlas/out/index.html, knowledge-graph.json and md/
npm run atlas:check      # exit 1 if a reviewed guide is stale or an annotation is invalid (CI)
node tools/appatlas/cli.js help        # every command
```

Open `appatlas/out/index.html` straight from disk; it needs no server. `appatlas/out/` is generated and not committed.

## What is in it

| Page | What it shows | Where it comes from |
|---|---|---|
| Features | One per screen (52 today), plus background jobs and the four Supabase services | routes in `web/js/pages/<role>/main.js`, standalone pages, annotations |
| Admin guide | The same 10 questions for every feature | see "Where each answer comes from" |
| Admin manual | Every guide on one page; print it from the browser to make a PDF | features |
| Troubleshooting | Type a symptom → cause and fix, plus the database's own refusal messages | `appatlas/troubleshooting.yaml`, `raise exception` texts in the migrations |
| Onboarding | A checklist per team role of the screens that role opens | the **live** `role_permissions` matrix |
| Health | Answers filled, reviewed / draft / stale, untested features, features not fully live, import cycles, unused exports, files without a header | everything |
| Module map | Areas joined by the tables one changes and another reads | the graph |
| Database tables / functions | Columns, comments, RLS, row estimates, policies, triggers, what each function reads, writes, checks and refuses | migrations + live snapshot |
| api.js wrappers | The browser's whole backend surface, by line | `web/js/core/api.js` |
| Infrastructure | Auth, Postgres, Storage, Edge Functions: counted facts + migration guide | code + infrastructure annotations |
| Repo vs live | Migrations applied / applied by hand / not applied / live only; Edge Functions deployed or not; RLS and search_path checks | `appatlas/live-state.json` |
| Patch timeline | Every commit with the features it touched | `git log` |
| Decisions | The ADRs, linked to the features whose functions or files they name | `docs/adr/` |
| Impact estimator | Pick a table, function, wrapper, file, bucket or Edge Function → every feature that depends on it | the graph |

## Where each answer comes from

Every answer carries a label, so a draft never reads as fact:

| Label | Meaning |
|---|---|
| **Verified · live permissions** | "Who uses it?" read from the live permission matrix and the `has_permission()` checks in the functions the screen calls |
| **Verified · database** | "What does it affect?" from the tables those functions write (following triggers); "Common errors" from their `raise exception` messages and api.js `friendlyMessage()` |
| **From code comment** | The screen file's header comment (every file has one, code-rules §3), used when no annotation answers "What is this?" |
| **Troubleshooting catalog** | An entry in `appatlas/troubleshooting.yaml` linked to the feature |
| **Draft** | An annotation nobody has checked yet |
| **Reviewed** | An annotation a person checked against the app (`appatlas review`) |
| **Review needed** | Was reviewed, but the code it describes changed since |

With nothing to go on, the answer is **Documentation required** — never an invented explanation.

## First run and the annotation sprint (bootstrap)

On a repository with no annotations, the code alone answers about **38 %** of the admin questions (who uses it,
what it affects, the database's error messages, and "what is this" from header comments). The rest — why the
business needs it, what happens if you change it or set it up wrong, prerequisites, the steps, when to call a
developer — only a person knows. Expect about 15 minutes per screen to write them from scratch.

To make that tractable, **AI may be used once, offline, at setup** to draft the missing answers from the
header comments, the runbook and the module docs (ADR 0026). That was done on 30 Oct 2026: all 59 features have
`status: draft` annotations, and the atlas answers 587 of 590 questions — every draft labelled *Draft*. AI is never
called when AppAtlas runs.

Suggested review sprint (one person who knows the business, with the app open):

1. Start with what new staff touch first: run `node tools/appatlas/cli.js onboard --role city_manager` and review
   in that order. Then the customer app, then the rest by module.
2. For each feature, open its guide, try the steps in the app, correct `appatlas/annotations/<id>.yaml`.
3. Run `node tools/appatlas/cli.js review <id> --by "Your name"`. This sets `status: reviewed` and records
   the evidence hashes in `appatlas/review-lock.json`. Commit both files.
4. Aim for 5–10 features a day; the Health page shows progress.

New screen, no annotation? `node tools/appatlas/cli.js annotate <id>` writes a skeleton;
`--interactive` asks the questions one by one.

## Staleness — including changes elsewhere

A reviewed feature records the hash of everything it depends on: its screen files, each api.js wrapper it
calls (per function, not the whole file), the current body of every database function it reaches, each Edge
Function, and — per table it reads or writes — the list of migrations that touched that table.

So staleness is **transitive**: a new migration that alters `orders` marks every reviewed feature that uses
`orders` *Review needed*, with the reason ("Table orders changed: it is now touched by 2026…_x.sql"), not
only the screen whose file changed. Shared files (`ui.js`, `shell.js`, `supabase.js`, `config.js`,
`auth.js`, listed in `appatlas/appatlas.yaml`) are left out on purpose; a change to the escaping helper is
not a reason to re-review 52 guides. `audit_log` is never a reason either (a trigger writes it on every change).

`npm run atlas:check` fails CI while anything is stale. Re-read the guide, fix it, run `review` again.

## Annotations are code

`appatlas/annotations/*.yaml` and `appatlas/review-lock.json` are reviewed and merged like code. If two
branches edit the same annotation, resolve the conflict in git like any other file, then run
`appatlas review <id>` on the merged result so the lock matches it. The YAML subset AppAtlas reads is in
`tools/appatlas/lib/yaml.js`; unknown keys and bad indentation fail the build with a line number.

## Keeping "live" honest

The Repo-vs-live page is only as fresh as `appatlas/live-state.json`. After applying a migration or deploying an
Edge Function:

1. Run `supabase/tests/appatlas_snapshot.sql` in the Supabase SQL editor (read-only) and paste the `snapshot`
   cell over the `database` key of `appatlas/live-state.json`.
2. Update `edge_functions` in the same file from Dashboard → Edge Functions (SQL cannot see them) and set
   `edge_functions_checked`.
3. `npm run atlas`.

(The page tests have their own snapshot, `tests/fixtures/live-schema.json`, refreshed with
`supabase/tests/schema_snapshot.sql`, see [testing.md](testing.md).)

## Printing and PDF

The site's print styles hide the navigation. Open the **Admin manual** page and use the browser's
Print → Save as PDF. There is no built-in PDF export: it would need a headless browser, i.e. a new dependency.
The Markdown in `appatlas/out/md/` converts with any Markdown tool.

## Screenshots

Add `screenshot: appatlas/screenshots/<id>.png` to an annotation; the image is embedded in the guide.
None are taken yet.

## Limits (deliberate)

* The scanners read this project's conventions (api.js wrappers, `public.`-qualified SQL, header comments,
  `'#route': guard('module', …)`). They are text scanners, not parsers; a different project needs its own
  conventions written down first. Other languages and frameworks are not supported.
* A screen that borrows a helper from another screen gets only the api calls inside the borrowed export,
  not helpers that export calls in turn (one level).
* Security checks are linked to a feature when the check names one of its database functions or calls one
  that most checks do not use for setup.
