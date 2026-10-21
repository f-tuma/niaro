# UI system

One system for the web app (`/`) and the administration (`/admin`): the same
places for the same controls, so a person never looks for a button. Layout,
grouping and icons carry meaning; text is the last resort.

## Principles

- **Business hub first.** The app is the place where a person connects
  services and works with the information in them: the chat and the
  overview are the center, everything else (tasks, meetings, processes,
  skills, connections) is a view onto the same information. Every screen
  answers "what is here, what waits for me, what can I do next" in that
  order.
- **Terse.** No paragraph explains a screen; the title and the content do.
  Status badges only for exceptions (failed, waiting, draft, disabled). A
  label is at most three words. Icon buttons carry a tooltip or `aria-label`
  and nothing else. English is short and plain; the Czech localization uses
  the informal form (tykání) and is just as short.
- **Layout over copy.** Alignment and grouping say what belongs together;
  the next step is the only emphasised control on the screen.

## Where controls live

| Place                      | Controls, left to right                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page header (`PageHeader`) | title (+ muted count), then on the right: search/filters (`toolbar`), secondary actions (outline), **one** primary action, and a `…` menu last                         |
| List row / card            | click opens it; a trailing `…` menu holds the rest; at most one inline icon action (refresh, open link)                                                                |
| Detail page                | `PageHeader` with `EntityIcon` (lg), name, one status badge; the same action order as a list page; destructive actions only in the `…` menu                            |
| Sheet / dialog             | title and at most one line; the form; footer right-aligned: Cancel (ghost) then the primary action; destructive confirmation is an `AlertDialog`                       |
| Settings                   | `SettingRow`s: label left, control right; a danger zone is the last group                                                                                              |
| Tabs                       | `Tabs variant="line"` under the header; never nested tabs                                                                                                              |
| Empty state                | `Empty` with one sentence and one CTA                                                                                                                                  |
| Chat composer              | `@` and attachments left, voice and send right; Enter sends, Shift+Enter breaks a line                                                                                 |
| Widget (overview)          | header: icon, title, status line; right: refresh, expand, `…` menu; the body is the tool; "Ask" lives in the menu and on items, not as a strip                         |
| Sidebar (app)              | Overview, New chat, Search, Tasks, Meetings, Processes, Skills, Connections; then chats; the footer is the account menu (Administration for admins, Account, Sign out) |
| Sidebar (admin)            | workspace context once at the top; Services, AI, Processes, People, Settings groups; "Back to app" at the bottom                                                       |

Rules that follow from the table:

- One primary button per screen, rightmost before `…`. Never two filled
  buttons side by side.
- Destructive actions (delete, remove, revoke, sign out everywhere) are never
  a visible button beside the primary one: `…` menu or the danger zone, and
  always confirmed.
- Back navigation is the breadcrumb (desktop) or the `back` link of
  `PageHeader` (phone); no extra "Back" buttons in the content.
- The same thing has the same name everywhere: Draft, Enabled/Disabled,
  Runs, Workspace, Connections, Refresh, Ask, Edit, Remove (from a list)
  vs Delete (gone for good).
- Keyboard: Ctrl/Cmd+K search, Ctrl/Cmd+Shift+O new chat, Esc closes or stops.

## Components

shadcn only (`components/ui/*`), console patterns in `components/console/*`
(`PageHeader`, `DetailList`, `SettingRow`, `StatusBadge`, `EntityIcon`,
`Disclosure`). Tailwind tokens only: no arbitrary values, no inline styles
except CSS variables, no restyled primitives. `tabular-nums` for numbers and
times. Dark mode comes from the tokens.

## Widgets

Every widget on the overview has the same anatomy, in the card and in its
large view (the dialog). Hierarchy comes from placement and weight, not from
dividers: one line of controls, rows with fixed slots, actions always in the
same corner.

```
┌ card ──────────────────────────────────────────────────────────┐
│ Title                                            ⟳   ⤢   …     │  header: title, status line (muted)
│ this minute · Microsoft 365                                    │
│ 7 unread                         [All][Important][Unread]      │  toolbar: context left · controls right (one line, muted)
│ ● Sender ……………………………………………………………… 18. 10.  3:24                 │  row: leading · main · trailing
│   Subject …………………………………………………………………………… ⚠               │        line 2 = secondary (badge at its end)
│   summary (muted, one line) ………………………………………………………             │        line 3 = tertiary, card only
│ ○ Sender ……………………………………………………………… 15. 10. 11:09                 │
│   Subject …………………………………………………………………………                   │
│ 2 of 8                                                [⧉ Copy] │  footer: result left · tools right (optional)
└────────────────────────────────────────────────────────────────┘
```

```
┌ dialog ──────────────────────────────────────────────────────────────────────┐
│ Inbox · this minute · Microsoft 365                            ✦  ⟳   ✕      │  header as the card
├──────────────────────────┬───────────────────────────────────────────────────┤
│ 7 unread        [filters]│ Subject (base, medium)                      [↗]   │  detail header: title · meta · link top right
│──────────────────────────│ From · To: … · 18. 10. 3:24                       │
│ ● Sender         3:24    │                                                   │
│   Subject                │ Body (max-w-prose, scrolls)                       │
│ ○ Sender        11:09    │                                                   │
│   Subject       (muted bg, selected row = accent)                            │
│                          ├───────────────────────────────────────────────────┤
│                          │ [✦ Draft a reply] [✦ What do they want?]          │  action bar: AI actions, bottom of the detail
└──────────────────────────┴───────────────────────────────────────────────────┘
```

- **Header** (card and dialog): title, one muted status line; right: refresh,
  expand, `…`. Nothing else.
- **Toolbar**: at most one line directly under the header. Left: context
  (a count, "2 of 8", "7 unread"). Right: controls (filter chips, view
  switch, sort, table toggle), `size="xs"`. Shown only when it has content.
- **Rows** (`WidgetRow`): three slots. Leading: a 16 px state (unread dot,
  kind icon, check). Main: line 1 the name (medium when unread/urgent),
  line 2 the subject or detail (truncated), line 3 the gist (muted, card
  only). Trailing: time or number, right-aligned, `tabular-nums`, muted; a
  badge only for an exception, at the end of line 1. Rows divide with
  `divide-y`; the selected row is `bg-accent`, hover `bg-muted`.
- **Footer**: optional, one line: result or status left, tools right
  (`Copy`).
- **Detail in the card**: a popover on the row: title, meta line, the full
  text, then one action row: AI actions (outline xs, spark) first, the
  external link last.
- **Detail in the dialog** (`SplitPane` + `DetailPane`): the list on the left
  (fixed width, muted background, its toolbar on top, scrolls), the detail on
  the right: header (title, meta, external link top right), body (readable
  width, scrolls), and an **action bar at the bottom** with the AI actions.
  A detail that needs loading shows its status in the body, never in the
  header.
- **Dialog height**: tools (lists, calendar, chart, table) fill the dialog;
  a figure (KPI, briefing) keeps its natural height.
- **Empty**: one muted sentence, centred in the pane it belongs to.
