# Testing

```bash
npm test
```

| Suite | File | What it proves |
|---|---|---|
| Unit | `tests/unit.test.js` | HTML escaping, INR formatting, cart maths |
| Page smoke | `tests/pages.test.js` | Each screen renders against a fake backend and calls the right functions |
| Static | `tests/static.test.js` | No broken script/CSS/import paths; no secret keys shipped |
| Database security | `supabase/tests/security_test.sql` | 47 role / RLS / inventory / state-machine checks (run in the SQL editor; it rolls back and leaves no data) |

The fake backend lives in `tests/helpers/fake-supabase.js`. These tests do **not** replace trying the
real app in a browser.

## Adding a test
* New helper → `tests/unit.test.js`.
* New screen → a case in `tests/pages.test.js` using `setup({ session, profile, tables, rpc })`.
* New database rule → a numbered check in `security_test.sql`.
