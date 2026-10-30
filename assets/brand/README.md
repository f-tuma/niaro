# Niaro logo

Approved logo geometry, frozen on 2026-10-30 (NIAR-253). The three
canonical SVGs live in `source/`: main mark, optical micro mark, and outlined
lockup. Their eyes and mouth are real transparent holes. The only normalization
removes non-rendering root accessibility metadata and wraps the original children
in `g#logo`, which the Vardum passive SVG renderer requires for adaptive color.
All path data, transforms, canvas and default ink remain unchanged.

[delivery.json](delivery.json) records approved and normalized SHA-256 hashes,
asset/version IDs, recipes, output paths and immutable delivery links. These links
still require workspace read authorization; transformation signatures do not
grant access. Never put a workspace key in client code or a URL.

- [Application Vard](https://vardum.com/workspaces/6e3ef0b3-0f89-45d6-a7d5-4e8af30c64bb/vards/20dedd06-3411-4e46-8123-5241c9f780dd):
  the root `vardum.json` supplies native PNGs, Expo favicon and adaptive web SVGs.
- [Brand delivery Vard](https://vardum.com/workspaces/6e3ef0b3-0f89-45d6-a7d5-4e8af30c64bb/vards/c641140e-c182-4f64-a178-05478a35c4ae):
  this folder's `vardum.json` supplies only the three canonical SVGs.

Both Vards and all assets are private. Each output is read-only and explicitly
pinned to its reviewed source version. No recursive folder rules follow new uploads.

Vardum cannot recolor PNG output through `darkLayer`, and its passive SVG subset
rejects hidden groups, definitions and `use`. Preserving the approved white mark
on cobalt therefore needs one additional **service-only inverse source**, derived
by changing the main master root fill to white. Its exact hash and derivation are
in `delivery.json`; it is not a fourth repository master. All four service sources
have one final uploaded version each. Native outputs use this inverse; adaptive web SVGs use the
dark canonical sources with `darkLayer: "logo", darkColor: "#ffffff"`.

Production files, labels and keys use plain logo, micro, lockup and inverse names.
The service rename API changes display names only, so the authorized naming move
recreated our four task-owned sources at clean keys and retargeted the same Vard
item IDs. Superseded task-owned sources were removed after verifying the new pins
and bytes; no duplicate library sources remain.

## Pull for a build

After `pnpm install --frozen-lockfile`, run `npm run assets:pull` before the app or
admin build. This pins CLI **0.8.3** and restores both committed schema 2 snapshots
with `pull --frozen`. Matching local files need no download. Missing files require
the existing local Vardum login or a read-only `VARDUM_API_KEY` supplied by the CI
secret store. No credential is stored in either config, lock or delivered file.

The CLI searches upward for the nearest `vardum.json` and resolves output paths
relative to that config's directory. Running a command inside this folder selects
the Brand Vard; running it at repository root selects Application. The pull helper
sets both directories explicitly. Do not move either config without reviewing paths.

## Intentional update

Keep historical source versions and keys intact so old snapshots remain reachable.
For a newly approved change, upload only the changed source; derive the inverse
from the main geometry if needed. Read the editable Vard definition, review its
revision, and change only the intended items while preserving existing manual IDs,
literal pins and folder rules. A revision conflict requires a fresh read and review.
Update pins explicitly; a normal pull alone cannot advance a pinned source.

Run `npm run assets:refresh` to adopt reviewed remote configuration, then update
`delivery.json`, inspect the actual output, and review both `.vardum.lock` files.
Check source hashes, raster dimensions, alpha holes, icon framing and SVG light/dark
rendering before accepting the change. Builds keep using `assets:pull`, never refresh.
Do not edit generated PNGs or adaptive SVGs by hand. Frozen restore fails if retained
bytes, private access or signed transformation URLs become unavailable; it never
silently switches to latest.
