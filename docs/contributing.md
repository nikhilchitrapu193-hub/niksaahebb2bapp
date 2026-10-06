# Contributing

## Principles
1. **Readable over clever.** No frameworks, no build step, no magic. A new developer should follow any file top to bottom.
2. **Comment the *why*.** Every file starts with a header explaining its purpose.
3. **The database is the security boundary.** UI checks are convenience only.
4. **Escape everything.** Build markup with the `html` template from `core/ui.js`; never concatenate user data into HTML strings.

## Code style
ES modules · 2-space indent · single quotes · semicolons · `const` by default · small functions · JSDoc on exports.

## Common changes
* **New screen:** create `web/js/pages/<app>/thing.js` exporting a render function, add a route in that app's `main.js` and a nav link.
* **New backend call:** add a wrapper in `core/api.js`; screens never call Supabase directly.
* **New database change:** add a *new* migration file (never edit applied ones) in `supabase/migrations/`, with a matching security-test case.
* **New product field:** migration → `saveProduct` in `api.js` → form in `admin/products.js` → display where needed.

## Adding AI later
The app contains no AI by design. To add it safely:
* Call models from a **Supabase Edge Function**, never from the browser (keeps keys secret).
* Give the function the same role checks as the SQL functions.
* Add a thin wrapper in `api.js` so screens stay unchanged.
* Candidates: demand forecasting from `order_items`, reorder suggestions, photo tagging.

## Pull requests
Run `npm test`; update docs and ADRs if you change behaviour or make a significant decision.
