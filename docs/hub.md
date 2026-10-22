# Hub (Overview)

The web app opens on `/`: the person's own dashboard. It is laid out like a
TwentyCRM dashboard, but there is one per person and it is informative
first: widgets the person chose, each showing its latest data. Each person
sets up their own: a calendar, an inbox digest, numbers and charts, lists,
what waits for them. Widgets are **typed** and **AI-filled**: the person says
in their own words what a widget should show (its _brief_), and a closed,
read-only agent decides which of their services and read actions answer it,
collects the data and assembles it into the widget type's schema (enforced
structured output). The data's shape is driven by the widget type, its
content by the person's sources, never by one fixed intermediate service.
The agent can shape the dashboard too ("add a calendar with my meetings and
tasks with a deadline", "what's on my overview?").
A new chat lives at `/chat` ("New chat" in the sidebar, Ctrl/Cmd+Shift+O); the
dashboard's **Ask the assistant…** box and every widget's **Ask**
open it with the text ready in the composer.

## Widgets

Three kinds of items share the grid:

- **Typed widgets** (`kind: "widget"`, agent-hub/3): one of the registered
  widget types (below), filled by AI from the person's services, by the
  server, or by the app.
- **Úkoly** (built in, `kind: "tasks"`): the number of open items to resolve,
  the newest three, and how many runs wait for the person's answer or
  approval (from the chat session's work items). Links to `/tasks`. Every hub
  starts with it; it can be removed and added back from the gallery.
- **Process widgets** (`kind: "process"`, "Z procesu" in the gallery): a
  process the person can start (personal or company)
  that needs no input, i.e. its input schema has no required fields, and that
  changes nothing unattended: every service action its active (frozen)
  version can call is a read, or a write whose action requires approval in the
  current catalog policy (`unattendedEffect` in `service-processes.ts`).
  Processes with a write that runs without approval are refused
  (`hub_process_writes`) on add and again on every refresh, since the policy
  may change. Each card shows when its result was produced, a refresh button,
  a menu (**Set up view**, **Rename**, **Refresh**, **Remove from overview**)
  and the result in its view (below).

A person has at most twelve widgets. Opening the hub refreshes what is due;
between visits a server-side scheduler keeps `hourly` and `daily` AI widgets
fresh (see [When items are due](#when-items-are-due)).

### Widget types

| Type        | Name (cs)      | Filled by  | Shows                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar`  | Calendar       | AI         | events (title, start, end, all day, location, description, organizer, attendees up to 10, status accepted/tentative/none/declined, join link, source, link) and timed tasks with a detail; today, 3 days, a week or the work week; the grid runs midnight to midnight and opens on the working hours (dayStart–dayEnd) or earlier when something starts before them |
| `inbox`     | Inbox          | AI         | important emails: the source's message `id`, from, subject, received, one-line summary, importance, suggested action, unread flag, thread count, link; the body filters all/important/unread (chips on the count's row) and opens a row's detail with prepared questions; large, a mail reader that opens the message in full (below)                               |
| `briefing`  | Briefing       | AI         | a short Markdown summary and highlights with their source                                                                                                                                                                                                                                                                                                           |
| `kpi`       | Ukazatel       | AI         | one number with label, unit, change against a period, a short trend (sparkline), an optional target (progress bar) and the date it is from                                                                                                                                                                                                                          |
| `chart`     | Graf           | AI         | one series of labelled numbers (`points`) or up to four named `series` over the same labels, as bars (optionally stacked), lines, areas or a pie (points only); a toggle shows the numbers as a table                                                                                                                                                               |
| `followups` | Ozvat se       | AI         | people or deals to follow up with, why, last contact and priority                                                                                                                                                                                                                                                                                                   |
| `list`      | Seznam         | AI         | rows with a title, detail, a short tag and a link                                                                                                                                                                                                                                                                                                                   |
| `table`     | Tabulka        | AI         | up to 6 columns and 20 rows of text, numbers or empty cells, optional `rowLinks`; sortable columns, a text filter, copy as TSV                                                                                                                                                                                                                                      |
| `approvals` | Waiting for me | the app    | approvals and questions waiting in any chat (the chat session's work items), each linking to its chat                                                                                                                                                                                                                                                               |
| `meetings`  | Meetings       | the server | recent recorded meetings with their summary and number of tasks (`MeetingStore.recent`)                                                                                                                                                                                                                                                                             |

Every widget card has **Expand** (header icon and menu item): it opens the
same body large in a dialog, with refresh and "Ask" in the dialog header;
renderers get `expanded: true` and `onExpand` there and may show more (the
inbox a mail reader with the message's body, the chart its table under the
chart, the KPI its points).

The gallery also offers presets, a type with a ready brief and settings
(`HUB_WIDGET_PRESETS`: **Sales pipeline** is a bar chart of open deals by
stage, **My week** a week calendar), **Tasks** when it is not on the hub,
and **From a process** (the process list below).

### The widget registry

Every type is one module in `packages/protocol/widgets/<type>.ts`
(`defineWidget` in `define.ts`) and is listed in `widgets/index.ts`
(`HUB_WIDGET_TYPES`). A module exports:

- `type`, `version` (bumped when the data schema changes incompatibly; stored
  data of another version is dropped and the next fill starts over), `fill`
  (`ai`, `server` or `client`), `name` and `description` (cs/en);
- `data`: the zod schema of the widget's data. It is the structured output the
  fill must produce and what the web app renders. Every list has a maximum,
  every string a length, dates are ISO dates or date-times
  (`widgetDateTime`), links are `http(s)` only (`widgetLink`), so a model
  cannot put a `javascript:` link on the page;
- `config` and `defaultConfig`: what the person sets (range, count, chart
  kind…); unknown keys are dropped and missing ones defaulted
  (`hubWidgetConfig`);
- `size` (default and minimum, in grid cells) and default `refresh`;
- for AI types `brief` (the default request, cs/en), `guide` (type-specific
  guidance for the agent) and `describeConfig` (the settings in words);
- `sample(language)`: data for the gallery's preview.

`hubWidgetJsonSchema(type)` gives the JSON Schema of the data (zod 4
`toJSONSchema`) that the collecting agent sees. The web renderers live in
`apps/server-admin/web/app/widgets/<type>.tsx`, registered by type in
`widgets/index.ts`: `{type, icon, Body, Config?, describe?}` (`Body` renders
the data or the sample, `Config` is the type's settings form, `describe` the
settings in a few words for the chat handoff). A type the app does not know
shows "This version can't show this widget."

**Adding a widget type** is two modules: the protocol module (schema,
config, size, brief, guide, sample) added to `HUB_WIDGET_TYPES`, and the web
renderer added to `RENDERERS`. Nothing else changes: the server stores,
validates and fills it from the registry, the agent tools offer it, the
gallery lists it with its preview. `tests/hub-widgets.node.ts` checks every
registered type (unique key, bounded JSON Schema, valid defaults and samples,
sizes).

### How an AI widget is filled

A typed widget stores `{type, version, brief, config, sources, data, recipe,
requested}`; `sources` are services the person pointed it at (picked from
`GET /v1/:workspace/mentions?for=hub`, the services `hubReadableServices`
lists now, same schema as the `@` directory), a hint that narrows where it
reads, never a grant.
A refresh (`apps/server-identity/hub-fill.ts`, run by `HubRunner` under the
person's live credential, `IdentityService.hubFill`) is:

1. **Authority.** `hubReadableServices` lists the read actions the person may
   run unattended right now: enabled services and actions, `effect: read`,
   allowed under the current policy (the person's own switches for a
   personal-sign-in service, the administrator's role/user grants otherwise,
   `store.allowed`) and whose effective approval is `never`. Writes and
   actions that wait for approval never appear, so the fill cannot write or
   leave an approval behind. With sources, only those services; none left is
   `hub_source_unavailable`, none at all `service_unavailable`.
2. **Collect.** A closed Mastra agent (`apps/server-agent/widget-fill.ts`,
   no memory, no shared thread) gets the brief, the settings in words, the
   type's JSON Schema, the clock and time zone and the readable services, and
   exactly two tools: `find_actions {service, need}` (up to six of that
   service's read actions with their input schemas) and `read {action,
input}` (only an action `find_actions` returned, arguments checked against
   its input schema, then the ordinary `CatalogController.invoke` with a
   durable receipt). It decides which services, actions and arguments answer
   the brief. Tool results are projected (`projectResult`, 12 kB) and framed
   as untrusted data, never instructions. At most 6 steps and 6 reads.
3. **Assemble.** A second closed agent with no tools turns the reads into the
   type's data: one step, `structuredOutput` with the type's zod schema
   (`jsonPromptInjection`, strict), the reads again framed as untrusted. The
   result is validated against the schema again before it is stored
   (`hub.fillDone`); anything that does not fit is `hub_fill_invalid` and the
   last good data stays.
4. **Recipe.** The successful reads (`serviceId`, `actionId`, revisions,
   input) are kept on the server as the widget's recipe; the page sees only
   the services' names and the number of reads ("From CRM, Calendar"). Next
   time, a recipe whose inputs hold no dates and whose actions are unchanged
   and still readable is **replayed** without the collecting agent (one model
   call for assembly). A recipe with dates ("2026-10-16", "today") is a hint:
   its actions are offered right away and the agent adjusts the arguments to
   now. A changed brief, settings or sources drops the recipe.

Budget: every fill is its own root in the inference ledger
(`hub-fill/<itemId>/<uuid>`), with `HUB_FILL_CAPS` (8 model calls, 400k
tokens, $2) narrowed by the workspace policy as usual (adaptive reservation,
see [inference budget](inference-budget.md)); each model call re-checks the
person's credential and the configured model. It uses the workspace's chat
model (`catalog_model_required` without one).

Failures keep the last good data and show a short reason:
`hub_fill_invalid`, `hub_fill_no_data` (nothing was read),
`hub_fill_failed`, `hub_source_unavailable`, `service_unavailable`,
`connection_required` (a personal service needs sign-in), budget codes.

#### When a widget can't fill

Overview widgets read only **enabled read actions that run without approval**.
An MCP server's tools are imported as changes that ask first (its
`readOnlyHint` is not trusted), so a new MCP service is not readable until an
administrator marks its reads as _Read_ (the service's setup offers to apply
the server's read-only labels). The widget (or the alert above the grid, for
a refused add or change) shows one line and the step that fixes it
(`hubWidgetProblem`, `apps/server-admin/web/app/hub-copy.ts`):

| Code                                          | The person sees                                | Fix                                                                                                     |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `connection_required`                         | Your account isn't connected to the service    | **Connect account**: `/connections/<service>` (one source) or `/connections`                            |
| `model_unavailable`, `catalog_model_required` | The overview has no AI model                   | Admins: **Model routing** (`/admin/routing`); others: "Ask an administrator"                            |
| `service_unavailable`                         | No service the overview can read yet           | Admins: **Services** (`/admin/services`); others: "Ask an administrator"                                |
| `hub_source_unavailable`                      | The overview can't read the chosen service     | Admins: **Open service** (`/admin/services/<id>`); others: "Ask an administrator"                       |
| `hub_fill_no_data`, `hub_fill_failed`         | The assistant found nothing / couldn't read it | Refresh, or change the request                                                                          |
| `hub_conflict`, `hub_changed`                 | nothing at first                               | The change is sent once more on its own; a second refusal says "The overview didn't change. Try again." |

The widget form offers only readable services as sources; with none it says
so, and admins get a link to the services.

### Opening an item

A row of an AI widget can be opened in full: the inbox's **Read** (and
every row of its expanded reader) calls `POST /v1/:workspace/hub/open`
`{itemId, ref}` where `ref` is the email's `id`, the message id exactly as the
source returned it, which the fill copies into the data. The server
(`IdentityService.hubOpen`, `runHubOpen` in `hub-fill.ts`) checks that the
item is the person's own inbox widget at the current version and holds a row
with that id (`409 hub_item_unknown` otherwise, `409 hub_widget_invalid` for
another type), then runs the same closed read-only agent as a fill with the
same two tools, narrowed to the widget's sources or, without sources, to the
services its recipe read from: "read this one message in full by id", at most
2 reads, 3 steps, 3 model calls (`HUB_OPEN_LIMITS`, `HUB_OPEN_CAPS`: 100k
tokens, $0.50, its own ledger root `hub-open/<itemId>/<uuid>`). Reads go
through the ordinary controller with receipts, as in a fill. There is no
assembly step: the last successful read's result is unwrapped (an MCP text
block holding JSON) and the message is extracted on the server
deterministically (`apps/server-identity/hub-open.ts`): the object with
`id === ref`, else the shallowest object with a `subject`/`title` and a body
(`body.content` with `contentType`, `body`, `content`, `text`, `bodyPreview`,
`snippet`, `description`; Microsoft Graph and Gmail-shaped messages are
understood). An HTML body becomes plain text on the server (styles and
scripts dropped, blocks become lines, entities decoded); the page never
receives HTML. The answer is `HubItemDetail {subject, from, to? (≤10), at?,
text (≤20 000 chars, `truncated: true` when cut), link?}`; nothing found is
`422 hub_open_failed`, a personal service that needs sign-in `409
connection_required`. The model never rewrites the content. One open at a
time per person (a couple may wait, more is `429 hub_open_busy`).

**Rendering.** An HTML body also comes as `doc`, a tree the page renders
with React (never as HTML): `parse5` parses it on the server and only
allowed tags survive (`HUB_DOC_TAGS`: p, br, hr, a, strong, em, u, s, ul, ol,
li, blockquote, h1–h6, pre, code, table, thead, tbody, tr, td, th, img, div,
span; b/i/strike/del/font/center/section… are mapped onto them, style,
script, head, iframe, object, embed, form, svg, math and the like go with
their content, every other tag leaves only its content). Only `href`
(http(s) or mailto), `src` (https), `alt`, `colspan`/`rowspan` (1–20) are
kept; `javascript:` and `data:` URLs go. Depth ≤ 20, ≤ 5 000 nodes, ≤ 200 kB
serialized, text nodes ≤ 4 000 chars; beyond that `truncated: true`. The
reader (`widgets/email-doc.tsx`) maps each tag to an element with Tailwind
classes, links open in a new tab with `rel="noreferrer"`, and images are not
loaded until the person clicks **Show images** (then `loading="lazy"`,
`referrerPolicy="no-referrer"`); the choice lives in the component's state
for that message only. A plain-text body has no `doc`.

**Index.** An opened detail (the extracted detail, never HTML) is kept in
`agent_hub_item_detail` per person, item and ref for `HUB_DETAIL_TTL_MS`
(24 h); the answer carries `cached: true` when it came from there, and the
page shows an indexed body at once (the loading word appears only after
300 ms). A row the next fill no longer holds leaves the index (`fillDone`
prunes to the new ids); removing the item removes its index (cascade).

**Open recipe.** When the agent's read named the ref in its input, that
read is learned on the widget's recipe as `open: {serviceId,
serviceRevision, actionId, actionRevision, input, refPaths}` (`refPaths` are
the JSON paths in `input` whose value was the ref, e.g. `["id"]`). A later
open of another row first replays it with the ref put in at those paths,
under the same checks as a fill replay (same revisions, action still
readable, nothing else), with no model call; a stale recipe or a replay that
holds no message falls back to the agent, which learns afresh. A changed
brief, settings or sources drops the recipe, the open read included; a
successful fill keeps it.

**Prefetch.** After a successful inbox fill and after an open that learned
a recipe, the server opens the widget's other rows into the index in the
background under the same credential (`IdentityService.hubPrefetch`,
`runHubPrefetch`): rows with an id and no fresh detail, at most
`HUB_PREFETCH_LIMIT` (12) per run, one after the other, through the replay
path only (never the agent, no model call), its own ledger root
`hub-prefetch/<itemId>/<uuid>` under `HUB_FILL_CAPS`, stopping at the first
failure that concerns the person's authority (`connection_required`,
`catalog_action_denied`, `hub_open_unavailable`…). One chain per person,
one run per item at a time; it never delays the fill or open that started
it, and the page needs nothing new: opening checks the index, then the
replay, then the agent.

Built-in types need no AI and never refresh: `meetings` is read from the
person's meeting records on every dashboard read; `approvals` is drawn by
the app from the chat session's waiting work items (`data` is null on the
wire).

### Interacting through AI

Every widget has **Ask**: a new chat with a draft such as "About the widget
Calendar (today): " (the chat draft handoff, `saveDraft` + `/chat`). Items have
prepared requests: a calendar event's popover offers **Prepare me for this
meeting** ("Prepare me for the meeting "Team meeting" (10/17 9:00 AM–9:30 AM,
Room 2)."), an email **Draft a reply**, a follow-up **Write a
follow-up**. They only fill the composer; anything that writes goes through
the chat's normal approvals.

### Views of process widgets

Each process widget has a view: how its process's output is shown. The output schema
of the process's active, frozen version says which views fit (the widget's
`fields`: its top-level keys with their types; arrays name their scalar item
type or the scalar fields of their objects; sensitive keys are left out).

| View                                   | Needs                                                                                                                   | Shows                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `number`                               | a numeric field; optional label, unit and comparison with the previous refresh or another numeric field (e.g. a target) | a large number, its unit and the change                                                              |
| `chart` (`bar`, `line`, `area`, `pie`) | an array of objects: `x` names each point (text or number), `y` is its number; defaults to `label`/`value`-like keys    | one series (shadcn chart on recharts); a pie keeps four slices plus "Other" and names each beside it |
| `list`                                 | an array; for objects a `title` and optional `subtitle` field                                                           | up to 20 rows and the count of the rest                                                              |
| `table`                                | an array of objects and 1–6 columns                                                                                     | up to 20 rows                                                                                        |
| `text`                                 | a text field                                                                                                            | Markdown                                                                                             |
| `summary`                              | nothing                                                                                                                 | the original reading: text first, then up to twelve labelled values or short lists                   |
| `tasks`                                | the built-in widget only                                                                                                |                                                                                                      |
| `widget`                               | a typed widget only (agent-hub/3)                                                                                       | its type's renderer                                                                                  |

The server checks every view against the frozen output schema
(`hubResolveView` in `packages/protocol/hub-dashboard.ts`, shared with the web
app so the sheet offers only what fits) and fills in defaults (chart axes,
list title). A widget added without a view gets one from the schema
(`hubDefaultView`): a lone number becomes `number`, a lone text `text`, a lone
array a `chart` (≤ 3 fields with a label and a number), a `table` (3+ fields)
or a `list`; anything richer keeps `summary`. If a newer process version no
longer has the view's fields, the widget says so and offers **Set up
view** instead of showing wrong data.

A widget's data is projected on the server from a bounded, redacted copy of
the latest good output (`hubSnapshot`, `hubWidgetData` in
`apps/server-identity/hub-widgets.ts`): sensitive keys and credential-like
values are removed exactly as for the summary, strings are clipped, arrays
keep 50 entries (fewer when the copy would exceed 64 KiB) with their full
length for "+N more". The copy before it is kept for the `previous`
comparison. A failed refresh keeps both.

### Layout

Widgets sit on a twelve-column grid (rows of 5rem): `{x, y, w, h}` with `x +
w ≤ 12`, `h ≤ 10`, and minimum and default sizes: per view for process
widgets and Tasks (`HUB_WIDGET_SIZES`: number 2×2, chart 3×3, table 4×3,
tasks/list/text/summary 3×2), per type for typed widgets (the registry's
`size`; `hubItemSize` picks the right one). A new
widget takes the first free place for its default size. Adding happens only in
edit mode: **Edit** turns it on (an empty dashboard shows just **Edit
overview**), **Add widget** opens the gallery. In edit mode the page draws
the grid's cells for every occupied row plus one free row (free and occupied
cells look different, `hub-slot`), and while a widget is dragged or resized
(or its grip has keyboard focus) a ghost rectangle shows exactly where it
lands (`hub-ghost`). A grip moves a widget and the corner resizes it, by
pointer (whole cells) or arrow keys; widgets in the way move down and
everything floats up, so the grid never overlaps. The page shows the new grid at once and saves it
in one `layout` command. Below `md` the grid is one column in reading order
(top to bottom, then left to right) and editing only moves widgets up and down
(`reorder`, which lays the grid out again in that order keeping sizes).
Positions are kept in reading order for agent-hub/1 readers.

## Data

Per organization member and workspace, in the identity database
(`apps/server-identity/hub-store.ts`):

| Table            | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_hub`      | `(workspace_id, member_id)`, `user_id`, `revision`, `created_at`, `read_at` (when the person last opened the hub; added on start to an older database, null until then)                                                                                                                                                                                                                                                                                                                                       |
| `agent_hub_item` | `id`, `kind` (`tasks`, `process` or `widget`), `process_id`, `title` (≤ 80), `refresh` (`manual`, `hourly`, `daily`, `on_open`), `position`, `created_at`, `result` (JSON), `layout` (JSON), `view` (JSON), `shape` (JSON: the output fields with the version and digest they were read from), `snapshot` (JSON: the latest and previous redacted outputs), `widget` (JSON, typed widgets: type, version, brief, config, sources, the latest good data, the recipe with its reads, a pending refresh request) |

The latest result is `{status: running | waiting | succeeded | failed,
startedAt, producedAt, runId?, conversationId?, waiting?: approval | question,
error?, output?, source?: schedule | open | manual}` (`source` says what
started the refresh: the scheduler, opening the hub, or the person's button,
add or changed request; clients may ignore it, the card shows only "5 min
ago" as before). `output` is a compact, redacted reading of the run's output
(`hubOutput`): never raw JSON, sensitive keys and credential-like strings are
removed (by key words such as token, jwt, cookie, session, otp, pin, secret,
password, apikey, authorization, and by value shapes such as JWTs, GitHub,
Slack, GitLab, AWS, OpenAI-style and Stripe keys, this server's MCP tokens and
bearer tokens), strings are clipped. A failed refresh keeps the last good output and
its time.

Rows reference `member(id)` and `agent_workspace(id)` with `ON DELETE CASCADE`,
and a trigger on `agent_workspace_member` removes a person's hub when their
workspace access is removed. Tables are created with `IF NOT EXISTS`; an older
database gains them on start. A database from before the dashboard gains the
four widget columns on start: every item becomes a `summary` widget (Tasks a
`tasks` widget) at its view's default size, packed in its old order; the
revision does not change. Output fields fill in on the next read or refresh;
the redacted copy with the next good refresh. A database from before typed
widgets (whose `kind` check allows only `tasks` and `process`) has its item
table rebuilt once on start with the new check and the `widget` column, every
row, column and index kept.

## How a refresh runs

An AI widget is filled as described in
[How an AI widget is filled](#how-an-ai-widget-is-filled): `HubRunner` calls
`IdentityService.hubFill` in the background with the person's live credential;
the fill stores its data itself (`hub.fillDone`) and a failure is recorded on
the item (`hub.record`), keeping the last good data. Typed widgets have no
chat. A process item refreshes through exactly the steps of a manual start, under the
person's live app credential (the web app's session credential), in the
background on the server (`apps/server-identity/hub-runner.ts`):

1. The person's start inventory is read again. A missing process fails with
   `hub_process_unavailable`, a blocked one with its reason (for example
   `connection_required`, `budget_unavailable`), and one that now requires
   input with `hub_process_needs_input`. A process that would now write
   without approval fails with `hub_process_writes` before anything starts
   (checked when the refresh is requested and again right before it starts).
2. The item's own chat `chat-hub-<itemId>` is created once (later refreshes
   replay the same `conversation.create`).
3. The form is prepared with origin `{type: "command", conversationId:
chat-hub-<itemId>, requestId}`, then the ordinary process coordinator starts
   it with empty input `{}`.
4. The result is read from the admitted run's journal: status, its pending
   approval or question, its failure code, or its output.

The chat id ties every run to its item: recording a run checks that the
admission belongs to the person (`forParent`), names the item's process and
has the item's chat as origin. No new origin type was added: the start origin
union is shared by output references and app parsers, and the dedicated chat
already identifies the item.

A failed refresh shows **Couldn't refresh** once, with the short reason
when it is known (for example "The process hit its step limit.") and **Open
chat** for the item's chat. A run that waits for an approval or an answer shows **Waiting for you** with a link
to the item's chat, where the ordinary work card takes the decision; it also
appears in Tasks. The next hub read updates the item from the run's journal
(passive: nothing is started, resumed or approved). A refresh this server no
longer runs (for example after a restart) is shown as interrupted. Runs are
never retried after admission, so an unconfirmed effect is not repeated.

Refreshes run one at a time per person, whichever credential (web or app)
asked; the hub lane is per person as well, so one person never holds more than
one chat or process slot plus one hub slot of `NIARO_MAX_CONCURRENT_RUNS`. The person's agent handles one request
at a time; a refresh waits (up to about two minutes) while a chat request runs,
and a chat message sent while a refresh runs gets the usual "assistant is busy"
notice.

### When items are due

Opening the hub sends one `refresh {stale: true}`; an item is due when it never
ran (unless it is `manual`), or its last result is older than its policy: `on_open` 5 minutes,
`hourly` 1 hour, `daily` 24 hours or a new day in the workspace time zone;
`manual` only on the refresh button. A failed item retries on a later open
after 15 minutes (not for `manual`). An item the person adds (or whose brief,
settings or sources they change) refreshes right away. An item the agent adds
is `manual` and never runs on its own: the card says **New — refresh it yourself**
until the person refreshes it (and may then choose a schedule). Once the
person has refreshed an AI widget, the agent may ask for a fresh fill
(`hub_refresh`): it is marked `requested` and is due on the next open.
Built-in typed widgets are never due.

**The scheduler** (`apps/server-identity/hub-scheduler.ts`, started by the
identity service at boot, stopped on close) keeps `hourly` and `daily` AI
widgets fresh between visits, so the person finds current data on open. Every
`intervalSeconds` (profile `administration.identity.hub.scheduler`, default
300, `0` disables it; administration → Settings changes it at runtime) it lists every hub's typed widgets and starts the fills
that are due by their setting: `hourly` when the data is older than an hour,
`daily` older than 24 hours; `on_open` and `manual` are never scheduled and
process widgets are not scheduled (they need the person's live credential).
A scheduled fill runs exactly like one on open (`IdentityService.hubFill`
through `HubRunner`, in the person's lane): the same authority checks against
the person's current membership and read actions (checked again at every
step; no bearer is involved, a personal service uses the sign-in the person
stored), the same receipts, its own ledger root `hub-fill/<itemId>/<uuid>`
under `HUB_FILL_CAPS`, the data stored by `hub.fillDone` and, for an inbox,
the same prefetch afterwards. The result's `source` is `schedule`; the data
then counts as fresh on open, so opening the hub does not fill it again
within its period. Limits: at most `maxPerTick` fills per tick (default 10,
the oldest data first), one per person per tick and never while one of the
person's widgets is filling (a refresh the person starts meanwhile reuses the
running fill, nothing is duplicated); a widget whose scheduled fill failed
waits an hour, six after two failures in a row; a workspace whose inference
budget refused a scheduled fill (`catalog_budget_*`) waits an hour; people
who have not opened their hub for `idleDays` (default 14; `agent_hub.read_at`,
set on every hub read or command over the app API) are left alone. Each tick
writes one `hub_schedule` operator log line (`due`, `started`, `skipped` by
reason) when `NIARO_LOG=1`.

## API

The app API (`/v1/:workspace/hub`), the same bearer credential the web app's
chat session and the mobile app use. The web app calls it through
`ClientSession.readHub` / `sendHubCommand` with `agent-hub/3`.

- `GET /v1/:workspace/hub?language=cs|en&profile=agent-hub/3` →
  `HubDashboardV3`: every item as a `HubCard` (the agent-hub/2 widget plus
  `kind: "widget"` items with `view: {type: "widget"}` and `widget: {type,
version, fill, brief, config, sources: [{id, name}], data, recipe:
{services, reads} | null, requested}`; `widget` is null for Tasks and
  process widgets). The data is validated against the type's schema on the
  server and again by the client.
- `GET /v1/:workspace/hub?language=cs|en[&profile=agent-hub/2]` →
  `agent-hub/1` `HubView {profile, scope, revision, items, tasks: {open,
top}}`, or with the profile the dashboard `HubDashboard`: the same plus each
  item's `layout`, `view`, `data` (the view's projected data, null without a
  good output or when the output lacks the view's fields) and `fields` (null
  while the process cannot be read). Reading never starts a refresh. Another
  `profile` value is `400`. Older profiles never see typed widgets; their
  `layout` and `reorder` commands keep the typed widgets in place (a layout
  that would overlap one is `400 hub_layout_invalid`).
- `POST` with one command (4 KiB at most), answered in the command's own
  profile. All profiles:
  - `{profile, type: "add", kind: "process", processId, title?, refresh?}`
    (default refresh `daily`; starts its first refresh); in `agent-hub/2` also
    `view?` (checked; chosen from the schema when absent) and `layout?` (used
    when free, else the first free place)
  - `{profile, type: "add", kind: "tasks"}`
  - `{profile, type: "remove", itemId}` (removing a missing item is not an
    error; the rest float up)
  - `{profile, type: "rename", itemId, title}`
  - `{profile, type: "setRefresh", itemId, refresh}`
  - `{profile, type: "reorder", itemIds}` (all current ids, once each, else
    `409 hub_changed`; re-packs the grid in that order)
  - `{profile, type: "refresh", itemIds}` or `{profile, type: "refresh",
stale: true}`

  `agent-hub/3` only:
  - `{profile, type: "add", kind: "widget", widget: {type, brief?, config?,
sources?: serviceId[]}, title?, refresh?, layout?}`: the type's default
    brief, config, title (its name) and refresh fill what is missing; sources
    must be services the person can read from now (`409
hub_source_unavailable`); an unknown type or a config that does not fit
    is `409 hub_widget_invalid`. An AI widget starts its first fill.
  - `{profile, type: "setWidget", itemId, brief?, config?, sources?}`: a
    typed widget's request; the recipe is dropped and an AI widget fills again.

  `agent-hub/2` and `/3`:
  - `{profile, type: "setView", itemId, view}`: checked against the output
    schema of the process's active version, read again now; a view that needs
    more room grows the widget and moves others down
  - `{profile, type: "layout", items: [{itemId, layout}]}`: the whole grid,
    every item once (`409 hub_changed`), inside the grid, at least each
    view's minimum and not overlapping (`400 hub_layout_invalid`)

- `POST /v1/:workspace/hub/open?language=cs|en` with `{itemId, ref}` (2 KiB
  at most) → `HubItemDetail` plus `cached` (true when it came from the
  server's index), the one row of an AI widget read in full (see
  [Opening an item](#opening-an-item)); `ClientSession.openHubItem`.
  Errors: `409 hub_item_unknown` / `hub_widget_invalid` / `connection_required`,
  `422 hub_open_failed`, `429 hub_open_busy`, `404` for another person's item.

  Errors: `401`, `400 invalid_payload` / `identity_invalid_input` /
  `hub_layout_invalid`, `404 hub_item_not_found` / `hub_process_unavailable`,
  `409 hub_process_needs_input` / `hub_process_writes` /
  `hub_process_unavailable` / `hub_view_invalid` / `hub_item_exists` /
  `hub_full` / `hub_changed` / `hub_widget_invalid` /
  `hub_source_unavailable`.

Every call authenticates the credential and membership in the identity queue;
adding re-reads the person's start inventory; another person's items are
`404`. The hub is per person; administrators have no access to anyone else's.

## Agent tools

When the client can review processes (the web and mobile apps), the chat agent
gets seven tools (`apps/server-identity/mastra-domain.ts`):

- `hub_list`: widgets with their size and latest status and time; typed
  widgets with their type, brief, settings, the services they read from and
  compact data (`waitsForPerson` while an agent-added one has not been
  refreshed); process widgets with their view, compact output, the views
  their output allows and its fields (`key`, `type`, item fields as
  `key:type`); `widgetTypes` (each type with its name, description, fill,
  default settings and an example brief); and `addable` (up to 20 processes
  the person can start without input, that write nothing unattended and are
  not on the hub yet, each with its possible `views` and `fields`). Returned
  as data, never as instructions.
- `hub_add_widget {type, brief?, config?, title?, size?}`: adds a typed
  widget ("add a calendar with my meetings and tasks with a deadline" →
  `calendar` with that brief). Like every agent add it is `manual`: it reads
  nothing until the person refreshes it on the page. A replayed tool call adds
  the same widget.
- `hub_set_widget {itemId, brief?, config?, title?, size?}`: changes a typed
  widget's request, settings, title or size; nothing runs.
- `hub_refresh {itemId}`: asks for a fresh fill of an AI widget on the next
  open; refused (`hub_confirm_required`) while an agent-added widget waits for
  the person's first refresh.
- `hub_add {processId, title?, view?, size?}`: adds one process from
  `addable`, checked against the person's inventory, write policy and output
  schema at that moment. `view` is the protocol's view; a `type` alone (and
  e.g. `chart: "pie"`) takes the first fitting fields. `size` is `{w, h}` in
  grid cells. A replayed tool call adds the same widget, not a second one. It
  starts nothing and the widget is `manual`: nothing runs until the person
  refreshes it on the page.
- `hub_set_view {itemId, view?, size?}`: changes a widget's view and/or size
  (the same checks); it runs nothing.
- `hub_remove {itemId}`.

Each call holds the identity queue and rechecks current authority first.
Refusals come back as `{error: code}` (for example `hub_view_invalid`). The
instructions tell the agent to use them only when the person asks about or to
change their overview, to prefer a typed widget with a brief in the person's
words (and not to read the data itself for it), and to add a process only
when the person names it. Hub tool calls mark the turn private in later provider history,
like Tasks.

When the person wants a repeatable process rather than something to look at
and nothing in `addable` fits, the agent does not send them to Processes: it calls
`process_propose` with `addToHub: true` and `hubView` (`number`, `chart`,
`list`, `table` or `text`), which tells the designer what output suits that
view (for a chart: one array of `{label, value}`). Saving it adds the widget,
whose default view then follows from that output (see below).

## Processes from chat

Asking in chat for something the overview cannot show yet drafts it: the
agent's `process_propose` runs the process designer for a personal process
and ends the turn with a card (steps, inputs, services, **Add to
overview** pre-ticked when the process is eligible: no required input and no
write without approval). **Save and turn on** saves, freezes, tests (with a
generated scripted suite), turns it on and adds the item with refresh
`daily`; the item does not run then, it refreshes the next time the overview
opens. A process that is not eligible is saved and turned on without the
item. Details, the API and the cases that stop for a person are in
[service processes](service-processes.md#processes-from-chat).

## Creating items for the hub

A widget is any active process without required input. Useful ones,
created in **Processes → New process** (the designer) as personal processes:

- **My day**: "Every morning, list today's meetings from my calendar (Microsoft 365) with time and title, and the deadlines that end today. No inputs.
  Output: summary (short text) and meetings (list: time, title)." It uses the calendar
  service's read action and one agent step for the summary.
- **Task summary**: "Load my open tasks from To Do / CRM and summarize what is
  overdue and what is due today. No inputs. Output: summary and overdue (list
  of titles)."

- **Companies in the CRM**: "Count the companies in the CRM. No inputs.
  Output: count (number)." It becomes a `number` widget.
- **Opportunities by stage**: "Group the open opportunities in the CRM by
  stage. No inputs. Output: stages (list: label, value)." It becomes a bar
  chart; switch it to a pie in **Set up view**.

Test and activate the process; it then appears in **Add widget** and in
the agent's `addable`. Asking for it in chat does all of this from one card
(above). In the `summary` view, output fields named `summary`, `text`,
`markdown`, `report`, `message` or `content` (or a single text field) are
shown as text; other fields as labelled values, arrays as short lists.

## Verification

- `tests/hub.node.ts`: store and domain (seeding, per-person isolation,
  eligibility, limits, reorder, results from journals, waiting and failures,
  interruption, staleness, cascade on member/access/workspace removal, output
  redaction), and the dashboard: grid placing, moving, resizing, packing and
  layout checks; views from output schemas (defaults, choices, refusals);
  redacted snapshots and their projection per view; agent-hub/2 add with a
  view, setView, layout, agent-hub/1 answers and reorder; the previous value
  kept for comparison; migration of a database from before the dashboard.
- `tests/hub-widgets.node.ts`: the registry (unique types, bounded JSON
  Schemas, valid defaults, samples and sizes; http-only links, rectangular
  tables, config defaults), agent-hub/3 adds with defaults, checked sources
  and built-ins (meetings from the server, approvals from the app), fills
  storing validated data and a recipe (invalid data refused, a changed
  request drops the recipe, failures keep the last data), older profiles
  without typed widgets (their layout and reorder keep them in place), due
  and requested refreshes, the agent's typed widgets (manual, replay,
  `hub_confirm_required`), card validation and the one-time table rebuild of
  an older database.
- `tests/hub-fill.node.ts`: the fill end to end with the real catalog,
  controller, receipts and ledger and a synthetic model and service: only
  `find_actions` and `read` exist, a write is never listed nor run (no write
  or pending approval receipt), results are framed as untrusted, the schema
  is enforced (non-JSON, wrong shape, a `javascript:` link and nothing read
  are refused), a recipe is replayed with one model call, a dated recipe is a
  hint, a changed action is not replayed, the step limit and a model-call cap
  (refused before dispatch, recorded in the ledger), and readable actions
  following the administrator's grants and approvals and the person's own
  switches on a personal service.
- `tests/hub-http.node.ts`: real app API with paired members: add, background
  refresh through the coordinator in the item's chat, second refresh reuses the
  chat, isolation between people, a process that becomes unavailable,
  `profile=agent-hub/2` reads, `setView` with its data and a refused view, and
  the web app's `ClientSession` methods (agent-hub/3).
- `tests/hub-fill-http.node.ts`: an AI widget added over the app API is
  filled in the background by the runner under the member's credential (one
  read, data and recipe stored) and stays invisible to agent-hub/2 and /1.
- `tests/hub-scheduler.node.ts`: the scheduler with a fake clock: due
  selection per refresh kind (hourly, daily; on_open, manual and built-ins
  never), backoff after a failed scheduled fill (an hour, six after two in a
  row, the workspace after a budget refusal), idle people skipped,
  `maxPerTick` and one per person, coalescing with a refresh the person
  starts, disabled with interval 0, stop on close; and over the app API: a
  scheduled fill shows up with `source: "schedule"` under the member's own
  authority, and opening the hub does not fill it again within the hour.
- `tests/hub-open.node.ts`: opening an item: HTML to text, the message
  extracted from Graph, text, MCP-wrapped, listed and Gmail-shaped results
  (the asked id wins, nothing found is null, the text is bounded, only web
  links), `hub.openRequest` (own inbox only, a row it holds, another person
  or type refused), and the agent run with the real catalog and ledger: the
  two tools only, three model calls and no assembly, the message extracted
  from the read, the read limit, `hub_open_failed`, sources; the sanitized
  tree (dangerous tags, attributes and URLs dropped, limits); the learned
  open recipe replayed for another row without a model call, a stale one
  sending the agent again; the prefetch (bounded, serial, replay only, no
  model, stops on an authority failure); the index (TTL, pruned by a fill,
  gone with the item, never HTML).
- `tests/hub-open-http.node.ts`: `POST hub/open` over the app API returns the
  detail with its tree for the signed-in person (`cached: false`, one more
  read), the other row follows into the index in the background (one read, no
  model call) and both then answer `cached: true` without a read; an unknown
  row, a bad body or method, another person (404) and no credential are
  refused.
- `tests/mastra-domain.node.ts` ("hub tools …", "process_propose …"): tool
  exposure, `addable` with views and fields, refusals, a view from a type
  alone, `hub_set_view`, replay, removal, revoked authority, the `hubView` hint
  to the designer; "hub widget tools …": `hub_add_widget` (manual, replay,
  invalid config), `hub_set_widget`, `hub_refresh` refused before the person
  confirms, no service dispatch, revoked authority.
- `tests/web-hub.test.tsx`: every view's rendering, due refresh on open, edit
  mode (pointer and keyboard move and resize saving the whole grid, phone
  reorder, remove), the view sheet (only fitting views, saves rename and
  view), a widget whose output changed, the assistant's manual widget,
  **Ask the assistant…** handing the text to a new chat and no bottom strip.
- `tests/web-hub-widgets.test.tsx`: the empty dashboard's **Edit
  overview**, the gallery (every type with a preview from its sample), adding a
  calendar with brief, settings and sources, editing a brief (`setWidget`),
  the calendar, inbox and KPI renderers, grid cells and the ghost while
  dragging, resizing and with keyboard focus, **Ask** and item requests,
  AI widget states with their sources, approvals from work items and an
  unknown type.
- `tests/web-app-routes.test.tsx`: `/` opens the dashboard, `/chat` a new chat,
  `/chat/:id` a saved one; **New chat** and **Overview** links; Ctrl/Cmd+K.

## Not yet

- The scheduler fills AI widgets only; process widgets still refresh on open
  (they need the person's live credential). Mobile has no hub screen yet (the
  API is ready).
- Hub chats are ordinary chats; the chat history lists them as "Overview" until a message gives them a title. If that chat becomes unusable, the refresh fails with a short reason; removing and adding the widget again gives it a new chat.
- Views read top-level output fields only (no nested paths); a chart shows one
  series (process view and the `chart` type alike); card documents in a
  process output are not rendered as cards.
- AI fills use the workspace's chat model and the ordinary read actions; they
  do not stream progress (the card shows a spinner) and are not run in
  parallel per person. A fill is one try: a failure waits for the next due
  open (15 minutes), the scheduler's backoff (an hour, six after two in a
  row) or the refresh button.
- `approvals` is drawn from the chat session's work items the app already
  has, so it shows only what that session knows (not other devices' runs that
  never synced).
- Recipes are replayed only when their inputs hold no dates; otherwise the
  agent runs every time with the recipe as a hint.
- A process proposed from chat gets its view from its output schema; the
  `hubView` preference only shapes the designer's request.
- The web bundle has no code splitting, so the chart library ships with the
  app.
