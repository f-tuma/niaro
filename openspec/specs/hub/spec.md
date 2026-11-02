# hub Specification

## Purpose

The Overview (hub) is each person's own dashboard on the web app's home page: widgets they choose, filled from their own services by a closed read-only agent, from process results, or by the server and app, so a person sees what matters at a glance and can act on it through chat.

## Requirements

### Requirement: Personal dashboard

The system SHALL keep one hub per organization member and workspace, visible only to that person, and SHALL open it at the web app's `/` route. Administrators MUST NOT read or change another person's hub. A hub SHALL hold at most twelve items. Removing a person's workspace access, the member or the workspace SHALL remove their hub.

#### Scenario: Another person's item

- **WHEN** a person reads, changes or opens an item id that belongs to someone else's hub
- **THEN** the server answers `404`

#### Scenario: Hub full

- **WHEN** a person adds an item to a hub that already holds twelve items
- **THEN** the add is refused with `409 hub_full`

#### Scenario: Access removed

- **WHEN** a person's access to the workspace is removed
- **THEN** their hub and its items are deleted

### Requirement: Item kinds

The hub SHALL hold three kinds of items: the built-in Tasks item (`kind: "tasks"`), process widgets (`kind: "process"`) and typed widgets (`kind: "widget"`). The Tasks item SHALL show the number of open items to resolve, the newest three, and how many runs wait for the person's answer or approval, and link to Tasks (see `tasks`). A new hub SHALL start with the Tasks item; it MAY be removed and added again, at most once per hub.

#### Scenario: Tasks added twice

- **WHEN** a person adds the Tasks item while it is already on the hub
- **THEN** the add is refused with `409 hub_item_exists`

### Requirement: Typed widget types

The system SHALL offer these typed widgets: `calendar`, `inbox`, `briefing`, `kpi`, `chart`, `followups`, `list` and `table` (filled by AI), `meetings` (filled by the server from the person's recent meetings with their summary and number of tasks) and `approvals` (drawn by the app from the chat session's waiting approvals and questions). The gallery SHALL show each type with a preview from sample data, plus ready presets.

#### Scenario: Unknown type in the app

- **WHEN** the web app receives a widget type it does not know
- **THEN** the card says this version cannot show the widget

### Requirement: Typed widget schema

Each widget type SHALL define a versioned data schema in which every list has a maximum, every string a length, dates are ISO dates or date-times and links are `http(s)` only, plus a settings schema with defaults, a default and minimum size and a default refresh. Stored data of another schema version SHALL be dropped and the next fill SHALL start over. Unknown settings keys SHALL be dropped and missing ones defaulted.

#### Scenario: Unsafe link in widget data

- **WHEN** a fill produces a widget link that is not `http` or `https` (for example `javascript:`)
- **THEN** the data fails the type's schema and is not stored

#### Scenario: Invalid widget settings

- **WHEN** a person adds a widget of an unknown type or with settings that do not fit the type
- **THEN** the add is refused with `409 hub_widget_invalid`

### Requirement: Widget brief and sources

An AI widget SHALL carry a brief (the person's words for what it shows, defaulting to the type's brief), settings and optional sources. Sources SHALL be services the person can read from now, as offered by `GET /v1/:workspace/mentions?for=hub`; they narrow where the fill reads and MUST NOT grant access. Changing the brief, settings or sources SHALL drop the widget's recipe and start a new fill.

#### Scenario: Unreadable source

- **WHEN** a person adds or changes a widget with a source service they cannot read unattended now
- **THEN** the command is refused with `409 hub_source_unavailable`

### Requirement: Read-only authority of AI fills

An AI widget fill SHALL run under the person's own live authority and SHALL only be able to run enabled read actions that the current policy lets the person run without approval (see `service-catalog`, `service-sign-in`). Writes and actions that need approval MUST NOT be offered to or run by a fill, and a fill MUST NOT leave an approval behind. Each read SHALL go through the ordinary action controller with a durable receipt.

#### Scenario: Write action present

- **WHEN** a service offers both a read and a write action and the person fills a widget from it
- **THEN** only the read action is offered and no write or pending-approval receipt is created

#### Scenario: Nothing readable

- **WHEN** a widget's sources leave no readable service
- **THEN** the fill fails with `hub_source_unavailable`, or with `service_unavailable` when the person can read no service at all

### Requirement: Collecting data

A fill SHALL use a closed agent with no memory and exactly two tools, `find_actions {service, need}` and `read {action, input}`. `read` SHALL accept only an action `find_actions` returned and SHALL validate its arguments against the action's input schema. Read results SHALL be bounded and framed as untrusted data, never instructions. Collection SHALL stay within 6 steps and 6 reads, and a fill within 8 model calls.

#### Scenario: Action not offered

- **WHEN** the collecting agent calls `read` with an action `find_actions` did not return
- **THEN** the read is refused and no service is called

#### Scenario: Nothing read

- **WHEN** the collecting agent reads nothing
- **THEN** the fill fails with `hub_fill_no_data` and the last good data stays

### Requirement: Assembling data

A second closed step with no tools SHALL turn the reads into the widget type's data under enforced structured output, with the reads again framed as untrusted. The result SHALL be validated against the type's schema again before it is stored. Fills SHALL use the workspace's chat model.

#### Scenario: Assembled data does not fit

- **WHEN** the assembly returns data that fails the type's schema
- **THEN** the fill fails with `hub_fill_invalid` and the last good data stays

#### Scenario: No chat model

- **WHEN** the workspace has no chat model
- **THEN** the fill fails with `catalog_model_required`

### Requirement: Recipes

After a successful fill the server SHALL keep the successful reads (service, action, revisions, input) as the widget's recipe and SHALL expose to the page only the services' names and the number of reads. A later fill SHALL replay a recipe without the collecting agent, with one model call for assembly, when its inputs hold no dates and its actions are unchanged and still readable. A recipe with dates SHALL only be a hint to the agent.

#### Scenario: Replay

- **WHEN** a widget with a date-free recipe whose actions are unchanged is refreshed
- **THEN** the reads are replayed and only the assembly calls the model

#### Scenario: Changed action

- **WHEN** an action in the recipe has a new revision or is no longer readable
- **THEN** the recipe is not replayed and the collecting agent runs

### Requirement: Fill failure reasons

A failed fill SHALL keep the last good data and record a short reason: `hub_fill_invalid`, `hub_fill_no_data`, `hub_fill_failed`, `hub_source_unavailable`, `service_unavailable`, `connection_required`, `service_access_denied` (the service refused the credential or permission for every read), a model code, or an inference budget code.

#### Scenario: Service refuses access

- **WHEN** every read of a fill is answered 401 or 403 by the service
- **THEN** the fill fails with `service_access_denied` and the last good data stays

### Requirement: Fill failures shown with a fix

The web app SHALL show a failed widget, or a refused add or change, as one line with the step that fixes it: connecting the account for `connection_required`; for administrators a link to model choice or services; for other people "Ask an administrator"; refresh or change the request when nothing was found. A conflicting change SHALL be resent once before it is reported.

#### Scenario: Personal service not connected

- **WHEN** a widget reads a personal-sign-in service the person has not connected
- **THEN** the widget shows that the account is not connected with a link to the connection

#### Scenario: Member without admin rights

- **WHEN** a member's widget fails with `service_unavailable`
- **THEN** the widget tells them to ask an administrator instead of linking to administration

### Requirement: Opening an inbox row

`POST /v1/:workspace/hub/open` with `{itemId, ref}` SHALL read one message of the person's own inbox widget in full, where `ref` is a message id the widget's current data holds. The server SHALL find the read with the same closed read-only agent and tools as a fill (at most 2 reads and 3 model calls), narrowed to the widget's sources or the services its recipe read from. Only one open per person SHALL run at a time.

#### Scenario: Unknown row

- **WHEN** `ref` is not a row of the widget's current data
- **THEN** the request is refused with `409 hub_item_unknown`

#### Scenario: Not an inbox widget

- **WHEN** the item is another widget type
- **THEN** the request is refused with `409 hub_widget_invalid`

#### Scenario: Too many opens

- **WHEN** a person already has an open running and two waiting
- **THEN** another open is refused with `429 hub_open_busy`

### Requirement: Opened message detail

The server SHALL extract the opened message deterministically from the read's result, without a model rewriting it, and answer a detail with subject, sender, up to 10 recipients, time, plain text of at most 20,000 characters (marked truncated when cut), an optional link and `cached`.

#### Scenario: Message not found

- **WHEN** no read returns the message
- **THEN** the request fails with `422 hub_open_failed`

#### Scenario: Personal service not connected

- **WHEN** the message's service needs the person's sign-in
- **THEN** the request fails with `409 connection_required`

### Requirement: Sanitized message body

An HTML message body MUST NOT reach the page as HTML. The server SHALL send plain text and a tree of allowed tags only (text structure, links, lists, quotes, headings, code, tables, images), keeping only `href` (http, https or mailto), `src` (https), `alt` and `colspan`/`rowspan` (1–20). Scripts, styles, frames, forms and SVG SHALL be dropped with their content. Depth (20), nodes (5,000), size (200 kB) and text nodes (4,000 characters) SHALL be bounded.

#### Scenario: Script in a message

- **WHEN** an opened message body contains a `<script>` element or a `javascript:` link
- **THEN** neither appears in the detail sent to the page

#### Scenario: Remote images

- **WHEN** a person opens a message with images
- **THEN** the images are not loaded until the person chooses to show them

### Requirement: Open recipe

The server SHALL learn the read that named the ref as the widget's open recipe and replay it for other rows, with the ref put in, without a model call and under the same checks as a fill replay. A stale recipe or a replay without a message SHALL fall back to the agent. A changed brief, settings or sources SHALL drop it; a successful fill SHALL keep it.

#### Scenario: Second row opened

- **WHEN** a person opens another row after an open recipe was learned
- **THEN** the message is read by replay with no model call

### Requirement: Detail index and prefetch

Opened details SHALL be kept per person, item and ref for 24 hours and answered with `cached: true`; a row a later fill no longer holds and a removed item SHALL leave the index. After a successful inbox fill, or an open that learned a recipe, the server SHALL open up to 12 other rows into the index in the background, by replay only, one at a time, stopping at the first failure that concerns the person's authority.

#### Scenario: Prefetched row

- **WHEN** a person opens a row that the prefetch already read
- **THEN** the detail is answered from the index with `cached: true` and no new read

### Requirement: Process widget eligibility

A process widget SHALL show the result of a process the person can start (see `process-execution`) that needs no input and changes nothing unattended: every service action its active version can call is a read or a write that requires approval under the current policy. The server SHALL check this on add and again before every refresh.

#### Scenario: Process that writes unattended

- **WHEN** a person adds, or a refresh would start, a process with a write that runs without approval
- **THEN** it is refused with `hub_process_writes` and nothing starts

#### Scenario: Process needs input

- **WHEN** a process on the hub now requires input
- **THEN** its refresh fails with `hub_process_needs_input`

#### Scenario: Process gone

- **WHEN** the person can no longer start the process
- **THEN** the add is refused or the refresh fails with `hub_process_unavailable`

### Requirement: Process widget refresh

A process widget refresh SHALL run as an ordinary manual start under the person's live credential, in the item's own chat `chat-hub-<itemId>`, with empty input. Its status, waiting approval or question, failure or output SHALL be read from the run's journal. A run MUST NOT be retried after admission, and a refresh the server no longer runs SHALL show as interrupted.

#### Scenario: Server restart during refresh

- **WHEN** the server restarts while a process widget refreshes
- **THEN** the refresh shows as interrupted and is not started again automatically

### Requirement: Waiting process widgets

A process widget whose run waits for an approval or answer SHALL show "Waiting for you" with a link to the item's chat, where the ordinary card takes the decision. Reading the hub MUST NOT start, resume or approve anything.

#### Scenario: Waiting for approval

- **WHEN** a process widget's run waits for approval
- **THEN** the card shows it waits for the person and links to the item's chat

### Requirement: Process widget views

Each process widget SHALL have a view checked against the output schema of the process's active version: `number`, `chart` (`bar`, `line`, `area`, `pie`), `list`, `table` (1–6 columns), `text` or `summary`. A widget added without a view SHALL get one derived from the schema. If a newer version lacks the view's fields, the widget SHALL say so and offer to set up the view instead of showing wrong data.

#### Scenario: View does not fit

- **WHEN** a person sets a `number` view on a process whose output has no numeric field
- **THEN** the change is refused with `409 hub_view_invalid`

### Requirement: Redacted process output

Process widget data SHALL be projected from a bounded, redacted copy of the latest good output, with the previous copy kept for comparison. Sensitive keys (such as token, secret, password, cookie, authorization) and credential-like values MUST be removed and strings clipped. A failed refresh SHALL keep the last good output and its time.

#### Scenario: Token in output

- **WHEN** a process output holds a field named `token` or a value shaped like an API key
- **THEN** it is removed from the widget's data and summary

### Requirement: Grid layout

Items SHALL sit on a twelve-column grid with positions `{x, y, w, h}`, `x + w ≤ 12`, `h ≤ 10`, at least each item's minimum size and without overlap. A new item SHALL take the first free place for its default size. A `layout` command SHALL carry every item exactly once; a `reorder` command SHALL carry all current ids once each and re-pack the grid in that order.

#### Scenario: Overlapping layout

- **WHEN** a `layout` command places two items on the same cells or below a minimum size
- **THEN** it is refused with `400 hub_layout_invalid`

#### Scenario: Stale item list

- **WHEN** a `layout` or `reorder` command does not name every current item exactly once
- **THEN** it is refused with `409 hub_changed`

### Requirement: Editing the dashboard

Widgets SHALL be added, moved and resized only in edit mode, by pointer or keyboard, with the page showing where a widget lands and saving the whole grid at once. Below the medium breakpoint the web app SHALL show one column in reading order and only allow moving items up and down. Every widget SHALL open large in a dialog.

#### Scenario: Phone width

- **WHEN** the hub is shown on a narrow screen in edit mode
- **THEN** widgets can only be moved up and down

### Requirement: Refresh policy

Each item SHALL have a refresh policy `manual`, `on_open`, `hourly` or `daily`. Opening the hub SHALL request one refresh of what is due: an item that never ran (unless `manual`), `on_open` after 5 minutes, `hourly` after an hour, `daily` after 24 hours or a new day in the workspace time zone, and a failed item (not `manual`) after 15 minutes. An item the person adds or changes SHALL refresh at once. Built-in typed widgets SHALL never refresh.

#### Scenario: Manual item on open

- **WHEN** the hub opens with a `manual` item that has never run
- **THEN** the item is not refreshed

#### Scenario: Daily widget next morning

- **WHEN** a `daily` item last refreshed yesterday in the workspace time zone and the hub opens today
- **THEN** the item is refreshed

### Requirement: Refresh concurrency

Refreshes SHALL run one at a time per person whichever credential asked, in a hub lane separate from the person's chat lane. A refresh SHALL wait while a chat request of the person runs, and a chat message sent during a refresh SHALL get the usual busy notice.

#### Scenario: Refresh during chat

- **WHEN** a refresh is due while the person's chat request runs
- **THEN** the refresh waits for the chat request instead of running beside it

### Requirement: Background scheduler

Every `intervalSeconds` (default 300, `0` disables) the server SHALL start due fills of `hourly` and `daily` AI widgets under each person's own current authority: at most `maxPerTick` per pass (default 10, oldest data first), one per person per pass, never while one of the person's widgets is filling. Other widgets SHALL NOT be scheduled. Owners and administrators SHALL be able to change these settings at runtime.

#### Scenario: Scheduled fill then open

- **WHEN** the scheduler filled an hourly widget and the person opens the hub within the hour
- **THEN** the widget shows the scheduled data with `source: "schedule"` and is not filled again

### Requirement: Scheduler backoff

The scheduler SHALL skip people who have not opened their hub for `idleDays` (default 14). A widget whose scheduled fill failed SHALL wait an hour, and six hours after two failures in a row. A workspace whose inference budget refused a scheduled fill SHALL wait an hour.

#### Scenario: Idle person

- **WHEN** a person has not opened their hub for longer than `idleDays`
- **THEN** the scheduler starts no fills for them

#### Scenario: Budget refusal

- **WHEN** a scheduled fill is refused by the workspace's inference budget
- **THEN** the scheduler starts no fills in that workspace for an hour

### Requirement: Inference budget of fills

Every fill, open and prefetch SHALL be its own root run in the inference ledger (see `inference-budget`), with caps narrowed by the workspace policy: a fill or prefetch at most 8 model calls, 400,000 tokens and $2; an open at most 3 model calls, 100,000 tokens and $0.50.

#### Scenario: Model call cap reached

- **WHEN** a fill would make a ninth model call
- **THEN** the call is refused before dispatch and the fill fails keeping the last good data

### Requirement: Hub read API

`GET /v1/:workspace/hub` with the person's bearer credential SHALL answer in the requested profile: `agent-hub/1` (items and tasks), `agent-hub/2` (also layout, view, projected data and output fields) or `agent-hub/3` (also typed widgets); another profile SHALL be `400`. Reading MUST NOT start a refresh. Older profiles SHALL never see typed widgets.

#### Scenario: Older profile

- **WHEN** a client reads the hub with `agent-hub/2` while it holds typed widgets
- **THEN** the typed widgets are left out of the answer

#### Scenario: Unknown profile

- **WHEN** a client reads the hub with an unsupported profile
- **THEN** the server answers `400`

### Requirement: Hub commands

`POST /v1/:workspace/hub` SHALL take one command of at most 4 KiB: `add`, `remove`, `rename`, `setRefresh`, `reorder` and `refresh` (`itemIds` or `stale: true`) in every profile; `setView` and `layout` in `agent-hub/2` and `/3`; `add` of a typed widget and `setWidget` in `agent-hub/3`. Older profiles' `layout` and `reorder` SHALL keep typed widgets in place. Removing a missing item SHALL NOT be an error.

#### Scenario: Remove twice

- **WHEN** a client removes an item that is already gone
- **THEN** the command succeeds and the other items float up

### Requirement: Agent hub tools

When the client can review processes, the chat agent SHALL get `hub_list`, `hub_add_widget`, `hub_set_widget`, `hub_refresh`, `hub_add`, `hub_set_view` and `hub_remove`, each rechecking the person's current authority and answering refusals as `{error: code}`. Results SHALL be data, never instructions. `hub_add` SHALL accept only processes eligible for the hub. Hub tool calls SHALL mark the turn private in later provider history.

#### Scenario: Revoked authority

- **WHEN** the person's workspace access was removed before the agent calls a hub tool
- **THEN** the tool is refused and the hub is unchanged

### Requirement: Agent-added items wait for the person

Items the agent adds SHALL be `manual` and read nothing until the person refreshes them on the page; a replayed tool call SHALL add the same item, not a second one. The agent MAY ask for a fresh fill only of a widget the person has refreshed before.

#### Scenario: Agent adds a calendar

- **WHEN** the person asks the agent to add a calendar of their meetings
- **THEN** a `calendar` widget with that brief is added as `manual` and no service is read

#### Scenario: Agent asks for a refresh too early

- **WHEN** the agent calls `hub_refresh` on a widget it added that the person has not yet refreshed
- **THEN** the call is refused with `hub_confirm_required`

#### Scenario: Agent refresh after confirmation

- **WHEN** the agent calls `hub_refresh` on a widget the person has refreshed before
- **THEN** the widget is marked requested and fills on the next hub open

### Requirement: Processes offered from chat

When nothing addable answers a request, the agent SHALL be able to draft a personal process with `process_propose`, `addToHub: true` and a preferred view (see `process-design`). The card SHALL pre-tick adding to the overview only when the process is eligible. Saving and turning it on SHALL add the item with refresh `daily` without running it, to refresh on the next open. An ineligible process SHALL be saved and turned on without the item.

#### Scenario: Ineligible proposal

- **WHEN** the proposed process has a write that runs without approval
- **THEN** the card does not offer adding it to the overview and saving adds no hub item

### Requirement: Asking about widgets

Every widget SHALL offer Ask, opening a new chat with a draft naming the widget, and the dashboard SHALL offer an Ask the assistant box with the same handoff. Items MAY offer prepared requests (prepare for a meeting, draft a reply, write a follow-up). These SHALL only fill the chat composer; anything that writes SHALL go through the chat's normal approvals.

#### Scenario: Draft a reply

- **WHEN** a person chooses Draft a reply on an inbox row
- **THEN** a new chat opens with the request in the composer and nothing is sent or written
