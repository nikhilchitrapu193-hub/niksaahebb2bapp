# Testing

```bash
npm test
```

| Suite | File | What it proves |
|---|---|---|
| Unit | `tests/unit.test.js` | HTML escaping, INR formatting, cart maths, order preview (MOV / fee), CSV, permissions, audit wording |
| Page smoke | `tests/pages.test.js` | Each screen renders against a fake backend and calls the right functions (incl. locations, sectors, roles, audit, customer terms, per-warehouse GRN, PO / fee in the cart, pin-code check) |
| Static | `tests/static.test.js` | No broken script/CSS/import paths; no secret keys shipped |
| Database security | `supabase/tests/security_test.sql` | 86 role / RLS / inventory / state-machine / permission / scope / audit checks (run in the SQL editor; it rolls back and leaves no data) |

The fake backend lives in `tests/helpers/fake-supabase.js`. These tests do **not** replace trying the
real app in a browser.

### Running the SQL test on a local Postgres (optional)
The SQL test also runs on a plain Postgres 16 if you first create the parts of Supabase it touches
(roles `anon` / `authenticated`, `auth.users`, `auth.uid()`, `storage.buckets` / `storage.objects`, and
default privileges for new tables): run `supabase/tests/local_postgres_stub.sql` first, then the migrations,
the seed and the test, as its header shows. The Supabase SQL editor needs none of this.

## Adding a test
* New helper → `tests/unit.test.js`.
* New screen → a case in `tests/pages.test.js` using `setup({ session, profile, tables, rpc })`.
* New database rule → a numbered check in `security_test.sql`.
