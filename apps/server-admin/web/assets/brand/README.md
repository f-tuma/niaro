# Web brand outputs

The root Application Vard generates `favicon.svg` (32² micro mark) and `logo.svg`
(outlined Niaro lockup, native 248.378 × 76 canvas). Both have dark ink by default
and white fill under `prefers-color-scheme: dark`, with transparent face holes.
The document head consumes the favicon; the shared authentication layout consumes
the lockup on sign-in and approval pages, preserving their status icon overrides.
Import SVGs through Vite so it can embed them into the existing bundle.

Restore with `npm run assets:pull`. Exact source/version IDs, recipes and transformed
links are in [delivery.json](../../../../../../assets/brand/delivery.json); the root
`.vardum.lock` pins byte checksums. Never use private delivery URLs in browser code.
