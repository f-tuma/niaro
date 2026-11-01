# Pet pages as a little device — design brief (mobile + web)

Status: **proposal**, 2026-11-01. Companion to `research.md` and `concept.html`.
Replaces the layout of `apps/mobile/PetProfile.tsx` and
`apps/server-admin/web/app/pet-page.tsx`; keeps every control, every server
command and the existing `PetView` renderer, states and expressions.

## 1. The idea in one picture

```
┌─ shell ───────────────────────────────┐   shell  = one card, the "device"
│ ┌─ screen ──────────────────────┐  ☾  │   screen = pet + name + about line
│ │                               │     │            + one honest status line
│ │           ( pet )             │     │   ☾      = Use memory switch
│ │                               │     │            ("the light": off → pet rests)
│ │ Niaro                         │     │
│ │ Produktový manažer · Vývoj    │     │   icon row = the six profile sections,
│ │ Zná 12 věcí o tvé práci       │     │            each with its honest count
│ └───────────────────────────────┘     │
│  [💼 5] [⧉ 3] [🔧 2] [👥 1] [💬 1] [⏱ ]  │   buttons = Saved · About you ·
│  [🔖 Uložené] [👤 O tobě] [🎨 Vzhled]  │            Appearance (+ … menu)
└───────────────────────────────────────┘
```

Tapping a section icon opens that section's **status screen**: the list of
observations with correct / classify / delete / sources, under a compact
shell. Nothing is a meter; every number is a count of stored observations.

## 2. Information architecture and complete control map

| Existing control / state | Where it lives now | Where it lives in the device |
| --- | --- | --- |
| Observed · Work | section button | icon row slot 1 (`briefcase`) → section screen |
| Observed · Projects | section button | icon row slot 2 (`workflow`) → section screen |
| Observed · Tools | section button | icon row slot 3 (`wrench`) → section screen |
| Observed · People | section button | icon row slot 4 (`users-round`) → section screen |
| Observed · Style | section button | icon row slot 5 (`message-square`) → section screen |
| Observed · Rhythm | section button | icon row slot 6 (`clock-3`) → section screen |
| Work / Personal scope | toolbar select / tabs | segmented control at the top of every section screen (`Pracovní | Osobní`); overview counts are work-only, like the look |
| Saved tab | top tab | device button **Uložené** → saved screen (same list layout, explicit items) |
| About you · job title, department | top tab with form | read-only line under the name on the screen; device button **O tobě** opens the edit sheet (2 fields, Cancel / Save) |
| Appearance · name | header button + form | device button **Vzhled** → appearance sheet, field 1 |
| Appearance · colour (8) | select / chips | appearance sheet: 8 swatches (real hex), name as `aria-label` |
| Appearance · shape (auto + 8) | select / chips | appearance sheet: chips, **Automaticky** first |
| Appearance · animate | switch in form | appearance sheet: `SettingRow` switch |
| Appearance · show in chat | switch in form | appearance sheet: `SettingRow` switch |
| Use memory switch | toolbar | shell top-right **☾** switch, labelled `Používat paměť`; off → pet `resting`, status line `Paměť spí` |
| History (earlier versions) | checkbox / switch in detail | section and saved screens: icon toggle `history`, `aria-pressed`, label `Předchozí verze` |
| Correct (observed) / Edit (explicit) | inline button | row `…` menu, first item; opens the inline editor under the row (textarea, Cancel / Save) |
| Delete | inline button + confirm | row `…` menu, last item, destructive, existing confirm dialog |
| Classify (mark personal / work) | inline button + confirm | row `…` menu, second item; existing confirm when it will erase (drop mode) |
| Sources (chat/meeting, date, link, removed) | caption / `details` | row disclosure `Zdroje (n)` → one line per source, link opens via `onOpenSource` / `href`; `Zdroj odstraněn` when removed |
| Trust / status meta | caption | row meta line: `Pozorování · naposledy včera` (uses `seenAt`), `Přidáno tebou`, `Ověřený výsledek`, `· Předchozí verze`, `· Nepoužívá se` |
| Load more | button | last row of a list, `Další`, disabled while busy |
| Manage memory (web `/me/memory`) | footer link / header `…` | web: shell `…` menu item **Správa paměti** → `/me/memory` (page keeps a compact shell on top). Mobile: `…` menu → **Správa paměti** sheet |
| Erase all | manager `…` / alert | manage-memory sheet or page, danger zone last, existing confirm |
| Personal things keep / drop | appearance footer | manage-memory sheet/page, `SettingRow` **Uchovávat osobní poznatky** (switch), existing drop confirm |
| Saved status (`Uloženo`) | live region text | live region text under the icon row, 2.5 s, no pet reaction |
| Profile loading | text in pet slot | screen: still fallback + `Načítání…`, icon row disabled |
| Profile error / unavailable | text + retry | screen: still fallback + `Nepodařilo se načíst` + **Zkusit znovu** (one button, inside screen) |
| Memory unavailable (plugin off) | text in list | status line `Paměť není dostupná`, switch disabled, pet `resting`, lists stay readable, correct/edit hidden |
| Memory off (opt out) | switch off | status line `Paměť spí`, pet `resting`, lists readable, correct/edit hidden, delete kept |
| Memory list loading | `Načítání…` | section screen: 3 row skeletons, status line unchanged |
| Memory list error | text + refresh | section screen: `Nepodařilo se načíst` + **Načíst aktuální stav** |
| Empty section / saved | `Zatím tu nic není.` | one muted sentence centred in the list; overview status line `Ještě tě poznává` when no section has observations |
| Save unconfirmed / conflict | alert with refresh + retry | inline alert above the list (section/saved) or above the sheet footer (appearance/about): existing copy, **Načíst aktuální stav** then **Zkusit znovu**; edit draft retained |
| Pet state | `idle` / `resting` | unchanged: `resting` when `!enabled || optOut`, else `idle` |

Nothing above adds a server command. Counts per section need one read-side
addition (open question 1); until then the icon row shows a dot for sections
that have at least one work observation (`profile.look[].weight > 0`).

## 3. Mobile layout (360–430 dp; 320 dp at font scale 2)

Page = existing `TopBar` ("Ty a Niaro", back) + one scroller. Shell padding 16,
screen padding 16, pet `min(220, width − 72) / fontScale`. Icon row buttons 48
dp square, gap 8, wrap to 3+3 when `fontScale ≥ 1.5` or width < 360.

**Overview**
```
┌──────────────────────────────┐ 360
│ ‹  Ty a Niaro             …  │  TopBar; … = Správa paměti, Vzhled
│ ┌──────────────────────────┐ │
│ │ ┌──────────────────┐  ☾  │ │  ☾ = Switch "Používat paměť" (label visible
│ │ │                  │ [on]│ │      at fontScale ≥1.5 as a row under screen)
│ │ │      ( pet )     │     │ │
│ │ │                  │     │ │
│ │ │ Niaro            │     │ │  title (22/700)
│ │ │ Produktový manažer     │ │  meta, only when set
│ │ │ Zná 12 věcí o tvé práci│ │  status line (16/400, secondary)
│ │ └──────────────────┘     │ │
│ │ [💼5][⧉3][🔧2][👥1][💬1][⏱]│ │  6 × 48 dp, count overline right of icon
│ │ [🔖 Uložené][👤 O tobě]  │ │  2 device buttons (Vzhled is in … and here)
│ │ [🎨 Vzhled]              │ │  48 dp chips, wrap
│ └──────────────────────────┘ │
│ Uloženo                      │  live region (transient)
└──────────────────────────────┘
```

**Section screen** (same component, `section` state; TopBar back returns and
restores focus to the opener)
```
┌──────────────────────────────┐
│ ‹  Práce                ⟲ …  │  ⟲ = history toggle (aria-pressed)
│ ┌──────────────────────────┐ │
│ │ (pet 56) Niaro · 5 · včera│ │  compact shell: count · last seenAt
│ └──────────────────────────┘ │
│ [ Pracovní ][ Osobní ]       │  segmented, 48 dp
│ Vede týdenní plánování …   … │  row: statement (16), … menu
│ Pozorování · naposledy včera │  meta 13 secondary
│ ▸ Zdroje (2)                 │  disclosure
│ ──────────────────────────── │
│ Píše specifikace v Notionu … │
│ …                            │
│ [ Další ]                    │  only with nextCursor
└──────────────────────────────┘
```

**Saved** = section screen with title `Uložené`, no segmented control, rows
with `Upravit` instead of `Opravit`. **About you** = sheet: title `O tobě`,
`Pozice`, `Oddělení`, footer Zrušit / Uložit. **Appearance** = sheet with a
small live pet (120) on top, `Jméno`, `Barva` swatches, `Tvar` chips,
`Pohyb peta`, `Zobrazit v chatu`, footer Zrušit / Uložit.

**Memory off**: same overview, pet resting, status `Paměť spí`, counts stay.
**Empty**: status `Ještě tě poznává`, icon row without counts, section screen
shows `Zatím tu nic není.` **Loading**: still fallback in screen,
`Načítání…`, row disabled. **Error**: `Nepodařilo se načíst` + `Zkusit znovu`.

**320 dp, font scale 2**: pet 124 dp; name wraps; status line 2 lines; icon
row 3+3 with counts under icons; device buttons one per line; section rows
keep `…` at 48 dp on the right, statement wraps freely.

## 4. Web layout

Existing sidebar (232 px) and page gutters; `PageHeader` title **Ty a Niaro**,
right: outline **Vzhled**, `…` (Správa paměti, Smazat vše is *not* here).

**Desktop ≥ 1100 px, overview** — shell centred, 480 px wide, pet 280.
```
┌ sidebar ┐┌──────────────────────────────────────────────────────────┐
│ …       ││ Ty a Niaro                         [Vzhled]  [ … ]      │
│ Pet  ●  ││                                                          │
│         ││        ┌─ shell 480 ───────────────────────┐              │
│         ││        │ ┌─ screen ───────────────┐  ☾ [on]│              │
│         ││        │ │        ( pet 280 )     │        │              │
│         ││        │ │ Niaro                  │        │              │
│         ││        │ │ Produktový manažer     │        │              │
│         ││        │ │ Zná 12 věcí o tvé práci│        │              │
│         ││        │ └────────────────────────┘        │              │
│         ││        │ [💼5][⧉3][🔧2][👥1][💬1][⏱ ]        │              │
│         ││        │ [🔖 Uložené] [👤 O tobě]           │              │
│         ││        └───────────────────────────────────┘              │
└─────────┘└──────────────────────────────────────────────────────────┘
```

**Desktop, section open** — shell docks left (360 px, sticky, pet 160),
status screen right (readable column ≤ 640 px).
```
┌──────────────────────────────────────────────────────────────────────┐
│ Ty a Niaro                                         [Vzhled]  [ … ]  │
│ ┌─ shell 360 ──────────┐  Práce                 [Pracovní|Osobní] ⟲ │
│ │ ┌ screen ────┐  ☾    │  5 poznatků · naposledy včera               │
│ │ │ (pet 160)  │       │  ───────────────────────────────────────── │
│ │ │ Niaro      │       │  Vede týdenní plánování týmu …           …  │
│ │ │ Zná 12 …   │       │  Pozorování · naposledy včera               │
│ │ └────────────┘       │  ▸ Zdroje (2)                               │
│ │ [💼5][⧉3][🔧2]       │  ───────────────────────────────────────── │
│ │ [👥1][💬1][⏱ ]       │  Píše specifikace v Notionu …            …  │
│ │ [🔖 Uložené][👤 O tobě]  …                                         │
│ └──────────────────────┘  [ Další ]                                 │
└──────────────────────────────────────────────────────────────────────┘
```
Selected icon keeps `aria-pressed`; clicking it again returns to the overview
(focus back to the icon). Saved and About you use the same split; About you
and Appearance are a right sheet (440 px) as in the previous round.

**Narrow ≤ 760 px** — the mobile layout: shell full width, section opens
below a compact shell strip, one scroller, no sticky.

**`/me/memory`** keeps its route and the `Správa paměti` title; its top is the
compact shell strip, then the Saved list, then a settings group: `SettingRow`
**Uchovávat osobní poznatky** and a danger zone with **Smazat vše**.

**States**: loading → still fallback + `Načítání…` in the screen; profile
error → `Nepodařilo se načíst` + `Zkusit znovu` inside the screen; memory
unavailable → status `Paměť není dostupná`, switch disabled; conflict → inline
`role="alert"` above the list with the existing two buttons.

## 5. Visual language

- **Shell**: web `background: var(--card)`, `border: 1px solid var(--border)`,
  radius `var(--radius-4xl)` (≈ 21 px); mobile `t.color.surface`,
  `t.color.border`, `t.radius.sheet` (24). No gloss, bevel, halo or texture.
- **Screen**: web `var(--background)` with inset hairline
  `inset 0 0 0 1px var(--border)`, radius `var(--radius-3xl)`; mobile
  `t.color.background`, `t.color.hairline`, `t.radius.group` (16). Slightly
  darker than the shell so the pet "sits inside".
- **Icon wells**: web `var(--secondary)` → selected `var(--accent)` with
  `var(--primary)` border; mobile `t.color.fill` → `t.color.accent.softBlue`
  with `t.color.action.link` icon. 48 dp min; count in `overline`
  `tabular-nums`, `muted-foreground` / `t.color.text.secondary`.
- **Typography**: web Manrope: name 20/600, about line `--text-md` muted,
  status `--text-md`; mobile `t.typography.title` (name), `meta` (about),
  `body` secondary (status).
- **Icons**: web lucide `BriefcaseBusiness, Workflow, Wrench, UsersRound,
  MessageSquare, Clock3` (existing), plus `Bookmark` (saved), `UserRound`
  (about), `Palette` (appearance), `Moon` (memory switch adornment),
  `History`, `Ellipsis`, `Pencil`, `Trash2`, `ExternalLink`. Mobile `Icon`
  names existing: `briefcase, person, chat, clock, history, more, edit, trash,
  link, sparkle, back`; add to `packages/ui` icon map: `workflow`, `wrench`,
  `people` (UsersRound), `bookmark`, `palette`, `moon` — all present in
  `lucide-react-native`.
- **Motion**: pet as built. Shell: icon press feedback 110 ms; screen content
  crossfade 220 ms on section change (`t.motion.stateTransition`); shell
  resize desktop 220 ms. Reduced motion or Animate off: instant layout, still
  pet, no crossfade. Nothing else moves; no bounce, no pointer chase.

## 6. Copy (new short strings; everything else reuses `pet-copy.ts`)

| Key | CS | EN |
| --- | --- | --- |
| statusKnows (n) | `Zná {n} věcí o tvé práci` | `Knows {n} work things` |
| statusKnowsSections (no counts) | `Zná tvou práci a nástroje` | `Knows your work, tools` |
| statusEmpty | `Ještě tě poznává` | `Still learning you` |
| statusAsleep | `Paměť spí` | `Memory asleep` |
| statusUnavailable | `Paměť není dostupná` (existing) | `Memory unavailable` |
| statusLoading | `Načítání…` (existing) | `Loading…` |
| statusError | `Nepodařilo se načíst` | `Couldn't load` |
| lastSeen | `naposledy {relative}` | `last {relative}` |
| countLabel (a11y) | `{n} poznatků` | `{n} observations` |
| sourcesCount | `Zdroje ({n})` | `Sources ({n})` |
| manage sheet title | `Správa paměti` (existing) | `Manage memory` |

Plural CS: 1 `věc`, 2–4 `věci`, 5+ `věcí`; 1 `poznatek`, 2–4 `poznatky`,
5+ `poznatků`. Relative time: `dnes`, `včera`, `před 3 dny` / `today`,
`yesterday`, `3 days ago`.

## 7. What the pet expresses here

- `idle` when memory is enabled and not opted out; touch reactions as built.
- `resting` when the plugin is off or the person opted out; the ☾ switch is the
  only control that changes it. Night/weather mood stays as built.
- No new state for loading, error, empty or conflict: those are text in the
  screen; the pet keeps its last honest state or the still fallback.
- No sign is fired by saves, opens or counts. Counts never animate.

## 8. Open questions for the owner

1. Per-section counts: add `count` next to `weight` in `PetProfile.look`
   (server-computed, work observations only)? Without it the icon row shows a
   dot per known section and the status line uses the section-list variant.
2. Should the overview status line also mention personal observations
   (`… a 3 osobní`), or stay work-only like the look?
3. Web `/me/memory`: keep it as a separate route with the compact shell, or
   fold it into the `…` menu sheet as on mobile?
4. May the Vzhled sheet include the on-demand growth/greeting line from the
   NIAR-246 spec, or drop that requirement?
5. Mobile: nested section screen inside the same component (TopBar back), or a
   real navigation push once the app has a stack?
