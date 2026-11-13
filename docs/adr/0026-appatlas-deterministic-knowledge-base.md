# 0026 — AppAtlas: a deterministic knowledge base, AI only once at setup
**Status:** Accepted (30 Oct 2026)

**Context.** The owner and future staff are not developers; future developers need to find their way around
52 screens, 156 database functions and 24 migrations. Docs written by hand drift from the code. The project
forbids AI in the app and new npm dependencies (AGENTS.md rule 7). The live database had also drifted from
what the team believed (a migration applied by hand, one recorded live with no file, two Edge Functions not
deployed), and nobody could see that.

**Decision.** `tools/appatlas/` builds a knowledge base from the repository and a read-only snapshot of the
live database:
* **No AI at runtime, no network, no new dependency.** Node built-ins only; text scanners that rely on the
  project's conventions instead of tree-sitter / SQL parsers (native builds would break "Windows-friendly,
  no build step"). Git is read through `git log`. Output is one self-contained HTML file plus JSON and Markdown.
* **Evidence first.** Who may use a screen, what it changes and the errors it can show are computed from the
  live permission matrix and the SQL functions the screen reaches. Everything else comes from YAML
  annotations; with neither, the answer is "Documentation required".
* **AI only once, offline, at setup.** The first round of annotations was drafted by an AI from the header
  comments, runbook and module docs, and every one is stored as `status: draft` and shown as *Draft*. Only a
  person promotes it with `appatlas review`. AppAtlas itself never calls a model.
* **Staleness is transitive.** A review records hashes of the screen files, the api.js wrappers, every
  reached function body and, per table, the migrations that touched it. A change anywhere along that chain
  marks the guide *Review needed*; `atlas:check` fails CI.
* **Live is a snapshot, not a connection.** `supabase/tests/appatlas_snapshot.sql` produces
  `appatlas/live-state.json`; "applied" is judged by the migration log *and* by the objects existing, so a
  migration pasted into the SQL editor shows as "applied by hand".

**Consequences.**
+ Admin and developer docs come from the same facts and cannot silently disagree with the code.
+ Repo/live drift, untested screens and dead exports are visible on one Health page.
+ The atlas regenerates in under a second; CI can block merges with stale guides.
− The scanners are convention-bound: code that bypasses `api.js` or unqualified SQL would be missed (both are
  already forbidden by the code rules).
− Annotations must be reviewed by a person to be trusted; until then they are labelled drafts.
− No built-in PDF (it would need a headless browser); the browser's Print does it.
