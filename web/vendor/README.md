# vendor/

Third-party code that is committed to the repo on purpose, so the app runs
with no CDN and no build step, and a CDN outage or compromise can't affect you.

| File          | Package                  | Version | Source |
|---------------|--------------------------|---------|--------|
| supabase.js   | @supabase/supabase-js    | 2.117.2 | `dist/umd/supabase.js` from the npm package (MIT licence) |

It is loaded with a plain `<script>` tag and exposes `window.supabase`.

## Upgrading
```bash
mkdir /tmp/sb && cd /tmp/sb && npm init -y && npm install @supabase/supabase-js
cp node_modules/@supabase/supabase-js/dist/umd/supabase.js <repo>/web/vendor/supabase.js
```
Update the version in the table above, then run the test suite (`npm test`).
