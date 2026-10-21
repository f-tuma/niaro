# Internal server plugins

Account-backed chat can call shipped local tools before selecting or executing an API/MCP action. The client still sends messages and renders existing cards; calculation and business logic stay on the server. A workspace needs a configured tool-capable routing model. Internal tools also work without connected external services. The legacy fixture interpreter is unchanged.

## Configuration and use

Add this optional block to the server JSON profile, then restart:

```json
"plugins": {
  "enabled": ["datetime"],
  "timeZone": "Europe/Prague"
}
```

Omitting the block enables the pure datetime plugin with **UTC**. Set the intended IANA timezone explicitly; the server never inherits the machine timezone. `enabled: []` disables internal tools at the operator level. A user can explicitly request another IANA timezone.

```sh
npm run server:check -- .servers/local/server.json
npm run server -- .servers/local/server.json
```

In the connected app, try “Just work out the date and time: next week on Tuesday at 14:00, for 30 minutes.” The model interprets the sentence and calls `internal_datetime_resolve`. An unclear week or morning/afternoon should produce a short clarification in the same chat.

## Progress in chat

The chat progress card includes **Date & time calculation** only after the server actually uses the plugin. It distinguishes running, completed, needs clarification and failed; repeated calls share one row with a count. The row stays completed if later inference fails and survives retry of a persisted calculation. The final answer replaces the transient progress card. This is calculation progress, not approval or confirmation of an external write.

Update/restart the server and reload the updated client bundle to use `agent-activity/3`; older clients can still request version 2 or receive default version 1. In development, `npm run start -- --web --port 8085` serves the client, and `npm run storybook:web` provides deterministic **Workflow / Request progress** examples without a model or credentials. See [progress protocol](protocol.md#request-progress-optional-agent-activity1-2-and-3) for scope and retry behavior.

## Workspace administration

Open **Plugins** at `/admin/plugins`, select a company and workspace, then edit the **Date & time** card. Owners and administrators can enable the tool, choose an IANA timezone and save. Members can inspect the settings but cannot change them; the recovery key cannot manage workspace plugins. Tool names, execution scope and supported dates are in the expandable technical details.

Workspaces initially inherit the profile settings. Saving creates a workspace override in the identity SQLite database; **Use server defaults**, followed by **Save changes**, removes that override. A restart preserves saved settings. No restart is needed for workspace changes. The operator's enabled list remains an upper bound: a workspace cannot re-enable an operator-disabled plugin. Per-user datetime overrides are not implemented; the memory plugin separately supports a personal opt-out.

The authenticated `GET /admin/api/identity/plugins?organizationId=…&workspaceId=…` returns the `agent-workspace-plugins/1` inventory, defaults, effective settings, source and revision. `POST` to the same path accepts `{organizationId, workspaceId, revision, settings}`; `settings` is `{enabled: ["datetime"], timeZone: "Europe/Prague"}` or `null` for inherited defaults. Stale revisions return 409, and updates are audited as `workspace.plugins_changed`. Client drafts survive transient refresh failures; authorization failures hide the form.

New commands use the current workspace settings. A settings change during an in-flight inference invalidates its result before dispatch. Retrying an existing command retains its already pinned reference clock/timezone and completed calculations; it does not reinterpret old relative dates against new defaults. External-service permissions remain independent.

Build the console with `npm run admin:build` and restart the server after updating the application code. For ongoing use, workspace changes are saved directly through the page.

### Test a calculation

Expand **Test calculation** below the settings card. Choose tomorrow, Tuesday of next week, a specific date, or an elapsed-minute offset. Add a local time and optional duration, then calculate. The panel shows local ISO, UTC, optional end times and the server reference instant; **JSON output** and **Copy JSON** expose the exact response. It uses saved workspace settings, so save or discard pending settings first.

The preview calls the same pure registry executor as chat, with no model call, service action, settings write or workflow operation. Members with workspace access may also test an enabled plugin. A nonexistent DST wall time requires changing the input; a repeated wall time offers the two UTC offsets for explicit selection. This tests the structured calculation, not the model's interpretation of natural language. Changing inputs clears the previous result; changing workspace/settings cancels it. The preview uses a fresh server clock on every run, while chat commands retain their pinned clock for retries.

`POST /admin/api/identity/plugins/preview` accepts `{organizationId, workspaceId, revision, tool: "internal_datetime_resolve", input}` with the same strict datetime input schema. It returns scope, revision, tool, `referenceNow`, the saved `timeZone` and the resolved/clarification `result`. Disabled tools return 403, stale revisions 409. Clients must reject a response whose scope, revision or saved timezone differs from their request snapshot; operator-default changes can happen across a server restart without changing a workspace override revision.

## Datetime v1

The server persists the reference instant and default timezone before the first inference. Retrying across midnight or a configuration change reuses both the clock and completed calculations.

| `when.kind`    | Additional fields                 | Meaning                                                                 |
| -------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `date`         | `date: "YYYY-MM-DD"`              | Explicit local date                                                     |
| `day_offset`   | `days: integer`                   | Calendar days from local today                                          |
| `week_day`     | `weeks: integer`, `weekday: 1..7` | Monday-based week; `0` this week, `1` next week; Monday `1`, Sunday `7` |
| `next_weekday` | `weekday: 1..7`                   | Next occurrence, excluding today                                        |
| `elapsed`      | `minutes: integer`                | Exact elapsed minutes from the reference instant                        |

Calendar modes require `time: "HH:mm"`. Optional `timeZone` overrides the default for a user-specified zone. `utcOffset: "+01:00"` disambiguates a repeated wall time only when explicitly specified by the user; the model must not invent an offset. Elapsed mode forbids `time` and `utcOffset`. Optional `durationMinutes` adds elapsed minutes, not wall-clock minutes.

Supported local dates are 2000–2100, with modern whole-minute UTC offsets from −14 to +14 hours. Calculation uses the Gregorian calendar and the Node runtime's IANA timezone data. Every possible offset is round-tripped to detect gaps and overlaps, including half-hour transitions and skipped dates. Invalid dates, missing times, nonexistent wall times and unresolved overlaps stop the external-action flow with a localized clarification. Historical second-based offsets and recurring schedules are not supported.

For reference `2026-09-27T21:30:00Z` and default `Europe/Prague`, this input:

```json
{
  "when": { "kind": "week_day", "weeks": 1, "weekday": 2 },
  "time": "14:00",
  "durationMinutes": 30
}
```

resolves to values including:

```json
{
  "date": "2026-09-29",
  "time": "14:00",
  "localDateTime": "2026-09-29T14:00:00",
  "timeZone": "Europe/Prague",
  "utcOffset": "+02:00",
  "iso": "2026-09-29T14:00:00+02:00",
  "utc": "2026-09-29T12:00:00.000Z",
  "endUtc": "2026-09-29T12:30:00.000Z",
  "endIso": "2026-09-29T14:30:00+02:00"
}
```

Each calculation has a server-owned ref such as `result_1`. An external action can use whole-value references, for example `{"body":{"startsAt":"$plugin.result_1.utc","endsAt":"$plugin.result_1.endUtc"}}`. The server substitutes exact scalars **before** action input validation and records resolved values in the immutable operation. Missing/forged fields, unresolved results, interpolation and tokens in property names are rejected. The model does not need to copy or recalculate the value; interpreting the original request is still its responsibility.

## Execution boundary and extension point

`apps/server-plugins/registry.ts` exposes the shipped manifest (`id`, `version`, `effect`, tool names), model schemas and validated invocation. Datetime is pure: its executor receives only the pinned clock, timezone and validated arguments, without service credentials, network access or an authorization capability.

At most four local calls are allowed per command across both routing stages. The runtime requires one tool call at a time, preserves assistant/tool provenance, persists results before another inference, and checks cancellation, actor access, policy revision and provider budget throughout the loop. Existing external-action grants, revision checks, idempotency and approval policy remain authoritative. A calculation never approves a write.

Only statically imported shipped code is accepted. Community installation, package/URL loading and a third-party execution sandbox are **not** implemented. Additional internal tools should extend the manifest/schema/executor boundary with tests; community plugins need a separate trust and execution model before remote code can be accepted.

## Verification

`tests/server-plugins.test.ts` covers calendar arithmetic, DST, offsets, strict schemas and binding. Plugin scenarios in `tests/service-catalog.node.ts` use synthetic providers and an in-memory database to test routing, worker inference, approval, replay, clock recovery, cancellation, revocation and malformed calls. `tests/workspace-plugins.node.ts` exercises authenticated HTTP, role/workspace isolation, runtime updates, persistence, conflicts, audit, operator restrictions and read-only previews (including DST clarification and offset selection). `tests/plugin-query.test.ts` covers stale-query/save races. Run `pnpm run check` for the full regression suite; no real service writes are required.

## Long-term memory (`memory`)

Back up the complete identity and workflow directories before upgrading. Deploy the updated server and console together; a saved memory plugin override is not understood by older server binaries.

The memory plugin is shipped with the server and opt-in. The operator must add it to the profile allowlist before a workspace manager can enable it in **Plugins → Memory**:

```json
{
  "plugins": {
    "enabled": ["datetime", "memory"],
    "timeZone": "Europe/Prague",
    "memory": {
      "retentionDays": 365,
      "maxContextChars": 4000,
      "maxItems": 8,
      "allowShared": false
    }
  }
}
```

Explicit `memory` settings are operator ceilings; workspaces can narrow them. Without explicit ceilings the workspace can configure the protocol bounds: 1–3,650 retention days, 500–12,000 context characters, 1–20 records and optional shared memory. Retention applies when a new record is saved. The plugin uses the scoped identity store; it is a context capability, not a pure datetime calculation or an external service action.

In the model planner, `memory_search` retrieves current attributed notes. `Zapamatuj si: Odpovídej česky a stručně.` / `Remember: Reply in Czech and keep answers concise.` explicitly permits saving that exact text. A model's inference, a quoted instruction or a service result cannot authorize a save. `Zapomeň na …` / `Forget …` with exact saved content permits erasure after search. The console supports private notes, revisions, deletion, personal opt-out and optional shared notes managed by owners/admins. Datetime changes preserve memory settings and vice versa.

### Correct a saved memory from chat

Send the whole correction as one message, with both the exact saved text and its replacement in JSON double quotes:

```text
Oprav paměť: "Odpovídej podrobně." na "Odpovídej stručně."
Revise memory: "Give detailed answers." to "Keep answers concise."
```

The separator can also be `→` or `->`. An optional `Prosím` or `Please` belongs at the start of the corresponding Czech or English command. JSON escaping supports quotes, backslashes and newlines inside either value. Each decoded value must contain 1–4,000 characters, with no leading or trailing whitespace. Text matching preserves case and content exactly; identical old and new values, unquoted values, extra instructions after the command and an instruction quoted inside another message are rejected.

The model searches for the old text, then calls `memory_revise` with the identified record's `id`, current `revision` and exact replacement `content`. The server permits correction of one active private record belonging to the authenticated person and workspace. It checks the old content and expected revision atomically, supersedes the old record and attributes the replacement to the actual user message. A stale revision produces a conflict; shared notes and candidates cannot be corrected through this chat tool. If several currently retrievable active private records contain the same exact old text, chat refuses the ambiguous correction; use the console to select an individual record. This check uses current source access and expiry inside the same mutation; expired or revoked duplicates do not create an ambiguity. A changed memory version also invalidates pending action arguments and approvals.

The chat correction and its paired agent tool receipt commit in the same identity database transaction. A failed journal checkpoint rolls back the correction too. After a committed correction, later tool calls from the old model batch are recorded as skipped, and a resumed loop loads fresh memory before planning again. Restart cannot leave a committed correction attached to the batch's obsolete memory version.

Ordinary `Remember …` commands remain additive. The server does not silently merge semantically similar notes or treat an opposite assertion as authorization to rewrite an earlier one. Use an explicit correction to replace the identified assertion. Exact retries reuse the recorded result; after erasure, retries return only deleted receipt metadata and cannot restore the old or replacement content.

`GET /admin/api/identity/memory?organizationId=…&workspaceId=…` returns `agent-memory/1`, the current version, plugin state, personal opt-out and at most 200 visible records. `POST` accepts strict scoped commands with an idempotent `requestId`: `remember` (`content`, `kind`, optional `scope`), `revise` (`id`, `revision`, `content`), `forget` (`id`, `revision`), or `preference` (`optOut`). The server supplies identity, source and trust. Disabled plugins reject new notes/revisions; inspection, opt-out and erasure remain available.

Private memory stays with its user and workspace. Shared notes never widen service access. Corrections preserve inspectable history until erasure; erasure scrubs the entire correction lineage. Retrieved payloads are transient in the loop, with only version/expiry/source metadata attached to an approval. Any stale context is rejected before dispatch. Saved memory erasure does not erase the original chat history or independent service receipts; expired payloads are scrubbed by maintenance at startup and hourly (and excluded from retrieval as soon as they expire). See [ADR 016](adr/016-scoped-agent-memory.md) for guarantees and remaining limits.
