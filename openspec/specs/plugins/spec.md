# plugins Specification

## Purpose

Plugins give the assistant's agent server-side tools that are not company services: pure calculations (date and time), work with the person's saved context (memory) and reads of the public web. The server ships built-in plugins; the operator and the organization owner can add or override plugins as trusted code, and workspace managers decide which are on.

## Requirements

### Requirement: Plugin package

The system SHALL treat a plugin as a directory named by its id containing `plugin.json` (what it is and may do) and `index.ts` (its tools). The server SHALL ship the built-in plugins `datetime`, `memory` and `web` and load operator plugins from the identity directory's `plugins/`, ignoring directories whose name starts with `.` and loading at most 50 operator plugins. A plugin whose id equals a built-in's SHALL override that built-in; any other id is an operator plugin.

#### Scenario: Operator plugin loaded

- **WHEN** the identity directory contains `plugins/word-count/` with a valid manifest and module
- **THEN** after start `word-count` is listed as an operator plugin

### Requirement: Manifest validation

The system SHALL validate `plugin.json` strictly, refusing unknown fields: `id` 2–40 characters of lowercase letters, digits and `-` starting with a letter; `version` ≥ 1; `name` and `description` as `{en, cs}`; `effect` `pure`, `context` or `network`; optional `capabilities`; 1–10 `tools` (`name`, `title`, `access`, `approval`); up to 20 `settings` of type `boolean`, `integer` (`min`/`max`) or `string` (`maxLength` ≤ 500, optional `options`), each with a label and a valid default.

#### Scenario: Unknown field

- **WHEN** a manifest contains a field `permissions`
- **THEN** the plugin does not load and the reason names the manifest

### Requirement: Tool declarations

Tool names SHALL be unique and start with `internal_<id with - as _>_` for pure and network plugins and `memory_` for the context plugin, so no plugin can shadow server tools. A `write` tool SHALL require `explicit_command` and a `read` tool `none`; pure and network plugins SHALL declare reads only. `context` SHALL go with the `memory` capability, held only by the plugin `memory`; `network` SHALL go with the `web` capability.

#### Scenario: Write tool without explicit command

- **WHEN** a manifest declares a `write` tool with approval `none`
- **THEN** the plugin does not load

#### Scenario: Memory capability claimed by another plugin

- **WHEN** a plugin other than `memory` declares the `memory` capability
- **THEN** the plugin does not load

### Requirement: Entry module contract

The system SHALL accept `plugin.json` and `index.ts` of at most 256 KB each, call the entry module's default export with the SDK (`definePlugin`, `defineTool`, `resolved`, `z`) and require the returned tools to match the manifest's tools exactly, each with a 1–4,000 character description, a zod object input schema and `run(input, ctx)`. The model's JSON schema SHALL be generated from the input schema and every call validated against it before `run`.

#### Scenario: Tool lists disagree

- **WHEN** `index.ts` defines a tool not declared in `plugin.json`
- **THEN** the plugin does not load and the reason says the tools do not match

### Requirement: Tool context

`run` SHALL receive a context with the plugin id, the turn's reference instant (kept on retry), the person's IANA time zone (the device's, else the workspace default), the workspace's frozen setting values, the workspace and person, and, by capability, the latest message and `memory`, or `web`. A plugin's `log` SHALL write to the operator log as `plugin_log`.

#### Scenario: Settings in context

- **WHEN** a workspace sets the `web` plugin's results per search to 3
- **THEN** the web tools receive `results: 3` in their context settings

### Requirement: Invalid plugins never stop the server

The system SHALL skip a plugin that fails validation or loading, report it in the operator log (`plugin_invalid` with directory and reason) and to owners and admins as a plugin that did not load, and start anyway. An invalid override SHALL leave the built-in in force.

#### Scenario: Broken override

- **WHEN** an override of `datetime` has a syntax error
- **THEN** the server starts with the built-in `datetime` and reports the override as not loaded

### Requirement: Overrides keep the built-in's contract

An override SHALL keep the built-in's effect and every one of its tool names; it MAY add tools.

#### Scenario: Override drops a tool

- **WHEN** an override of `datetime` removes `internal_datetime_resolve`
- **THEN** the override does not load and the built-in stays in force

### Requirement: Workspace enablement

The server profile's `plugins.enabled` (default `["datetime"]`) SHALL bound which built-ins workspaces may use and set the default for workspaces on server defaults. Operator plugins and the built-in `web` SHALL be available in every workspace, off unless named there. A workspace SHALL NOT turn on an unavailable plugin. Owners and admins SHALL turn plugins on or off and edit settings per workspace (revision-checked, audited as `workspace.plugins_changed`, no restart); members see them read-only.

#### Scenario: Plugin outside the allowlist

- **WHEN** an admin turns on `memory` in a workspace while the profile's `plugins.enabled` does not list it
- **THEN** the server refuses with `plugin_unavailable`

#### Scenario: Member edits plugins

- **WHEN** a member saves workspace plugin settings
- **THEN** the server answers `identity_forbidden`

#### Scenario: Stale revision

- **WHEN** an admin saves plugin settings with an outdated revision
- **THEN** the server answers 409 and nothing changes

#### Scenario: Back to server defaults

- **WHEN** an admin saves the workspace with server defaults
- **THEN** the workspace override is removed and the profile's defaults apply

### Requirement: Plugin settings

The system SHALL validate each workspace's setting values against the plugin's declaration when saved and again when read, fall back to the declared default for an invalid or missing value, and accept server-wide values under `plugins.settings.<plugin id>`. The time zone SHALL come from `plugins.timeZone` (default `UTC`; the server never uses the machine's zone), and memory's settings from `plugins.memory`, whose profile values are ceilings a workspace can only lower.

#### Scenario: Out-of-range value

- **WHEN** a workspace's stored value for an integer setting lies outside its declared bounds
- **THEN** the plugin receives the declared default

### Requirement: Pure tool results and receipts

A pure tool SHALL return synchronously either resolved values (at most 50 flat values: strings up to 200 characters, finite numbers, booleans) or a clarification with a reason; anything else SHALL be a failed call the model sees as `invalid_plugin_arguments`. At most four pure calls SHALL run per agent run (`plugin_limit` beyond). Each result SHALL be persisted as a receipt with a server-owned ref (`result_1`, …) and reused on retry with the same reference clock and time zone.

#### Scenario: Retried turn reuses the clock

- **WHEN** a turn that already computed a date is retried after midnight
- **THEN** the stored calculation and its original reference instant are reused

### Requirement: Binding plugin values into actions

The system SHALL let a service action argument refer to a pure result by a whole-value token `$plugin.result_N.<key>` and SHALL substitute the exact value before the action's input is validated. Missing or forged refs, unresolved results, tokens inside larger strings and tokens in property names SHALL be rejected without dispatch.

#### Scenario: Exact timestamp

- **WHEN** an action's `startsAt` argument is `"$plugin.result_1.utc"` and receipt `result_1` has `utc` `2026-09-29T12:00:00.000Z`
- **THEN** the action receives exactly that timestamp

### Requirement: Context and network tools

Context and network tools SHALL return a JSON object, also as a promise; a network tool's result SHALL be at most 60,000 characters as JSON. Network tools SHALL reach the web only through the host's `web` capability (`web-access`). The memory plugin's tools work through the host's `memory` capability (search, remember, forget, revise), and its behavior is specified in `memory`. A write tool SHALL run only when the person's latest message explicitly asks for it.

#### Scenario: Oversized network result

- **WHEN** a network tool returns a result larger than 60,000 characters
- **THEN** the call fails and the model is told

### Requirement: Plugin results are not permission

A plugin result SHALL be data for the model and SHALL never approve an action, grant access or bypass a service action's approval.

#### Scenario: Calculation before a write

- **WHEN** the agent computes a meeting time with `datetime` and then prepares a calendar write
- **THEN** the write still waits for its configured approval

### Requirement: Plugin files in the console

The system SHALL let only the organization owner read a plugin's `plugin.json` and `index.ts` in administration and, while editing is enabled, check, save, reset an override to the built-in, delete an operator plugin and create one from a template. A save SHALL be staged and loaded first and take effect without restart only when it loads; a refused save SHALL change nothing and say why. Every save, refused save, reset, delete and creation SHALL be audited as `server.plugin_changed`.

#### Scenario: Administrator opens files

- **WHEN** an organization admin who is not the owner requests a plugin's files
- **THEN** the server answers `identity_forbidden`

### Requirement: Operator can turn plugin editing off

The operator SHALL be able to turn console editing off with `NIARO_PLUGIN_EDITING=0` or `administration.identity.pluginEditing: false`; the files then stay readable by the owner, every change is refused with `plugin_editing_disabled` and audited as denied, and plugins in the data directory keep loading.

#### Scenario: Editing disabled

- **WHEN** the operator set `NIARO_PLUGIN_EDITING=0` and the owner saves a plugin
- **THEN** the save is refused with `plugin_editing_disabled` and audited as denied

### Requirement: Plugins are trusted code

The system SHALL run plugins in the server process with the server's permissions and without a sandbox, and SHALL NOT install plugins from packages or URLs; plugins come only as files in the plugin directories or from the console. The safety rules the server enforces are limited to the declarations, schemas, limits and capabilities above.

#### Scenario: Plugin uses a Node built-in

- **WHEN** an operator plugin's tool reads a file through `node:fs`
- **THEN** the read runs with the server process's file access

### Requirement: Date and time plugin

The built-in `datetime` plugin SHALL offer `internal_datetime_resolve`, converting a local date and time into exact local and UTC values. `when` SHALL be `date`, `day_offset`, `week_day` (Monday 1 … Sunday 7), `next_weekday` (excluding today) or `elapsed` minutes; `time`, `timeZone`, `utcOffset`, `durationMinutes` and `wholeDay` are optional; without a time the result spans the whole local day. Dates SHALL lie in 2000–2100. A nonexistent or ambiguous local time SHALL return a clarification.

#### Scenario: Next Tuesday afternoon

- **WHEN** the reference instant is `2026-09-27T21:30:00Z`, the zone `Europe/Prague` and the input `week_day` weeks 1 weekday 2 time `14:00` duration 30
- **THEN** the result has `utc` `2026-09-29T12:00:00.000Z` and `endUtc` `2026-09-29T12:30:00.000Z`

#### Scenario: Skipped wall time

- **WHEN** the input names 02:30 on the day clocks spring forward in `Europe/Prague`
- **THEN** the result is a clarification and no value is returned

### Requirement: Date and time preview

The system SHALL let anyone with access to a workspace run `internal_datetime_resolve` with the workspace's saved settings from administration, without a model call, service action or stored operation, returning the reference instant, the saved time zone and the result. A disabled plugin SHALL answer 403 and a stale workspace revision 409.

#### Scenario: Preview while disabled

- **WHEN** a person previews a calculation in a workspace where `datetime` is off
- **THEN** the server answers 403
