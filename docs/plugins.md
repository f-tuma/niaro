# Plugins

A plugin gives the assistant's agent tools that run on the server: a
calculation the model must not do itself (date & time), or a way to work with
the person's saved context (memory). A plugin is two files in a directory:

```
plugins/datetime/
  plugin.json   what the plugin is and what it may do
  index.ts      how its tools work
```

The server ships two plugins, `datetime` and `memory`, in `plugins/` of the
repository and the image. They are the reference examples: read
[`plugins/datetime/index.ts`](../plugins/datetime/index.ts) for a pure
calculation and [`plugins/memory/index.ts`](../plugins/memory/index.ts) for
write tools that need the person's explicit command. An owner can open,
change and add plugins in **Administration → Plugins**, or put them in the
server's data directory.

**A plugin is trusted code.** It runs inside the server process with the
server's permissions: it can read the server's files and reach the network
through Node's built-ins. Install and edit only plugins you would accept as a
change to the server itself. See [Security](#security).

- [How plugins work](#how-plugins-work)
- [Where plugins live](#where-plugins-live)
- [plugin.json](#pluginjson)
- [index.ts and the SDK](#indexts-and-the-sdk)
- [Write your first plugin](#write-your-first-plugin)
- [Editing in the console or as files](#editing-in-the-console-or-as-files)
- [Testing a plugin](#testing-a-plugin)
- [Security](#security)
- [Limits](#limits)

## How plugins work

### Lifecycle

1. **Start.** The server compiles in the built-in plugins and then loads the
   operator's plugins from the data directory, one directory per plugin. For
   each it validates `plugin.json`, imports `index.ts`, calls its default
   export with the SDK and checks the result against the manifest (the same
   tools, an input schema per tool). A plugin with the id of a built-in
   replaces the built-in (an _override_); any other id is an _operator
   plugin_.
2. **Invalid plugins are skipped, never fatal.** A plugin that does not
   validate or load is left out and reported: in the operator log
   (`plugin_invalid`, with the directory and the reason) and in
   Administration → Plugins under _Plugins that did not load_. An invalid
   override leaves the built-in in force. The server always starts.
3. **Saving in the console** writes the new files to a staging directory,
   loads them from there and checks them the same way. Only when that works
   are they moved into the data directory and put in force, without a
   restart. A refused save changes nothing and says why.
4. **A turn.** When a person sends a message, the plugins enabled for the
   workspace offer their tools to the model with the tool descriptions and
   the JSON schema generated from each tool's input schema. A tool call is
   validated against the input schema, then `run` gets the arguments and a
   context (time zone, settings, workspace, person). The result goes back to
   the model.

### How the agent sees and uses tools

- **Pure plugins** (`"effect": "pure"`) compute. `run` returns flat values
  synchronously; the server records them as a _receipt_ with a ref such as
  `result_1`. A later action can bind a value by reference,
  `"$plugin.result_1.utc"`, and the server substitutes the exact value before
  the action's input is validated, so the model never copies or recomputes
  it. At most four plugin calls run per message. The receipt is persisted: a
  retried message reuses it instead of computing again, with the same clock.
- **Context plugins** (`"effect": "context"`) work with the person's saved
  context through a host capability. Only memory exists: its tools use
  `ctx.memory`, which the server backs with the memory store (one transaction
  per change, retries return the first result, revisions, retention, erasure;
  see [ADR 016](adr/016-scoped-agent-memory.md)).
- Tool results are data for the model, never permission. A plugin result
  does not approve an action; external writes keep their own approval.

### Enablement per workspace

- **The server profile is the upper bound.** `plugins.enabled` lists the
  plugins workspaces may use and, for workspaces on the server's defaults,
  the ones that are on. A workspace cannot turn on a plugin the profile
  leaves out.
- **Operator plugins** (in the data directory, not overriding a built-in)
  are available in every workspace and start **off**. A workspace owner or
  administrator turns one on in Administration → Plugins → the plugin. Name
  it in `plugins.enabled` to have it on for workspaces on the server's
  defaults.
- An override replaces the built-in in every workspace where it is on.
- Deleting a plugin removes it from every workspace; a saved workspace list
  naming it simply ignores it.

### Settings

`plugin.json` declares settings (`boolean`, `integer` with bounds, `string`
with a length or a fixed choice). The plugin's page in the console shows a
field for each; values are validated against the declaration when saved and
again when read, and `run` receives this workspace's values as
`ctx.settings`. The profile can set server-wide values under
`plugins.settings.<plugin id>`.

Two settings are special for compatibility: the time zone is
`plugins.timeZone` (the server's setting, also in Administration → Settings),
and memory keeps its settings under `plugins.memory`, where the profile's
values are ceilings a workspace can only lower. Memory's `plugin.json`
declares the same fields and bounds for reference.

### Approvals

Each tool declares its `access` and `approval`:

| access  | approval           | Meaning                                                                                                                             |
| ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `none`             | Computes or looks up; runs when the model calls it.                                                                                 |
| `write` | `explicit_command` | Changes saved data; runs only when the person's latest message explicitly asks for it. Nothing the model or a service wrote counts. |

A write tool without `explicit_command` is refused at load. Pure plugins have
read tools only. The memory plugin checks the command itself
(`explicitCommand` and `correctionCommand` in its `index.ts`) and then calls
the server, which attributes the change to that message. The console shows
the declaration on the plugin's page under _Technical details_.

### Storage

Pure plugins store nothing. Memory's records live in the identity database
through `ctx.memory`; the data format did not change when memory became a
plugin. There is no general key-value store for plugins yet (see
[Limits](#limits)).

## Where plugins live

| What                        | Repository / host                    | Container                        |
| --------------------------- | ------------------------------------ | -------------------------------- |
| Built-in plugins            | `plugins/<id>/`                      | `/app/plugins/<id>/` (read-only) |
| Operator plugins, overrides | `<identity directory>/plugins/<id>/` | `/data/identity/plugins/<id>/`   |
| SDK (types and helpers)     | `packages/plugin-sdk/`               | `/app/packages/plugin-sdk/`      |

The data directory is the identity directory's `plugins/`
(`administration.identity.directory` in the profile), so plugins are in the
same backup as the rest of the identity data. The directory name must be the
plugin's id. Directories starting with `.` are ignored (the console stages
saves in `.staging/`). At most 50 operator plugins load.

## plugin.json

```json
{
  "id": "word-count",
  "version": 1,
  "name": { "en": "Word count", "cs": "Počet slov" },
  "description": {
    "en": "Counts the words and characters of a text.",
    "cs": "Spočítá slova a znaky v textu."
  },
  "effect": "pure",
  "tools": [
    {
      "name": "internal_word_count_count",
      "title": { "en": "Count words", "cs": "Spočítat slova" },
      "access": "read",
      "approval": "none"
    }
  ],
  "settings": {
    "countSpaces": {
      "type": "boolean",
      "label": {
        "en": "Count spaces as characters",
        "cs": "Počítat mezery jako znaky"
      },
      "default": false
    }
  }
}
```

| Field          | Required | Value                                                                                                                                                                  |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | yes      | 2–40 characters: lowercase letters, digits, `-`; starts with a letter. Equals the directory name.                                                                      |
| `version`      | yes      | Whole number ≥ 1. Raise it when the tools behave differently; receipts record it.                                                                                      |
| `name`         | yes      | `{ "en", "cs" }`, shown in the console.                                                                                                                                |
| `description`  | yes      | `{ "en", "cs" }`, one sentence for the plugin's card.                                                                                                                  |
| `effect`       | yes      | `pure` (computes) or `context` (works with saved context; needs a capability).                                                                                         |
| `capabilities` | no       | `["memory"]` for the memory plugin only.                                                                                                                               |
| `tools`        | yes      | 1–10 tools: `name`, `title` `{ en, cs }`, `access` (`read`, `write`), `approval` (`none`, `explicit_command`).                                                         |
| `settings`     | no       | Up to 20 fields by key (`camelCase`): `type` `boolean` / `integer` (`min`, `max`) / `string` (`maxLength` ≤ 500, optional `options`); `label` `{ en, cs }`; `default`. |

Rules checked at load:

- Tool names are unique and, for a pure plugin, start with
  `internal_<id with - as _>_` (for `word-count`: `internal_word_count_`).
  Memory's tools start with `memory_`. So a plugin cannot shadow a server
  tool such as `ask_user` or an `action_…`.
- `write` goes with `explicit_command`, `read` with `none`. Pure tools are
  read-only.
- `context` goes with the `memory` capability, and only the plugin `memory`
  has it.
- An override keeps the built-in's effect and every one of its tool names
  (the server and its prompts rely on them); it may add tools.
- Unknown fields are an error.

## index.ts and the SDK

The entry module default-exports a function. The server calls it with the SDK
and it returns `definePlugin({ tools })`:

```ts
import type { PluginSdk } from "@niaro/plugin-sdk";

export default function plugin({
  definePlugin,
  defineTool,
  resolved,
  z,
}: PluginSdk) {
  const count = defineTool({
    name: "internal_word_count_count",
    description: "Count the words and characters of a text the person gives.",
    input: z.strictObject({ text: z.string().min(1).max(20000) }),
    run(input, ctx) {
      const words = input.text.trim().split(/\s+/).filter(Boolean).length;
      const characters = ctx.settings.countSpaces
        ? input.text.length
        : input.text.replace(/\s/g, "").length;
      return resolved({ words, characters });
    },
  });
  return definePlugin({ tools: [count] });
}
```

The SDK is imported **as a type only** (`import type`). At runtime the module
gets everything through its argument, so it runs from any directory, including
the data volume, where package imports do not resolve. A plugin may import
Node built-ins (`node:crypto`, …) and nothing else at runtime;
`npm run lint` enforces this for `plugins/`. In the repository,
`@niaro/plugin-sdk` maps to `packages/plugin-sdk/index.ts` for the type
checker (`tsconfig.json` `paths`).

### SDK reference (`packages/plugin-sdk`)

| Export                                                                                   | What it is                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `definePlugin({ tools })`                                                                | The plugin definition. Returns it unchanged.                                                                                                                                         |
| `defineTool({ name, description, input, run })`                                          | One tool. `input` is a zod schema; the server validates the model's arguments with it and generates the JSON schema the model sees from it. `run(input, ctx)` gets the parsed input. |
| `resolved(values)`                                                                       | A pure tool's result: `{ status: "resolved", values }`.                                                                                                                              |
| `z`                                                                                      | zod 4, the same instance the server uses.                                                                                                                                            |
| `PluginSdk`, `ToolContext`, `PureToolResult`, `MemoryCapability`, `PluginManifestSchema` | Types, and the manifest schema the server validates with.                                                                                                                            |

`ToolContext` (`ctx`):

| Field                     | Value                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pluginId`                | The plugin's id.                                                                                     |
| `now`                     | The turn's reference instant (ISO, UTC). A retried turn keeps it.                                    |
| `timeZone`                | The person's IANA zone for the turn: the device's, else the workspace default.                       |
| `settings`                | This workspace's values of the plugin's settings (frozen).                                           |
| `workspaceId`, `personId` | Whom the agent works for.                                                                            |
| `request`                 | Context tools: the person's latest message (`text`, `commandId`, `conversationId`).                  |
| `memory`                  | Context tools of the memory plugin: `search`, `remember`, `forget`, `revise`.                        |
| `log`                     | `info` / `warn` / `error(message, details?)` → operator log `plugin_log`. Never log message content. |

Results:

- **Pure tools** return `PureToolResult` **synchronously**: `resolved(values)`
  with up to 50 flat values (strings up to 200 characters, finite numbers,
  booleans), or `{ status: "clarification", reason, timeZone }` with one of
  the date and time reasons, which stops the action flow and asks the
  person. A promise, a nested value or a longer string is an error the model
  sees as `invalid_plugin_arguments`.
- **Context tools** return any JSON object, also as a promise.
- Throwing (including a failed input validation) is a failed call; the model
  is told, the turn goes on.

## Write your first plugin

1. **Create it.** Administration → Plugins → **Add plugin**, enter an id
   such as `word-count`. The server writes the template (the plugin above)
   to `<identity directory>/plugins/word-count/` and opens its files. Without
   the console: copy the two files above into that directory and restart.
2. **Read the template.** `plugin.json` declares one read tool and one
   setting; `index.ts` defines the tool's input schema, description and
   `run`.
3. **Change it.** For example, also return the number of sentences: add
   `sentences: input.text.split(/[.!?]+/).filter((s) => s.trim()).length` to
   the values. Write the description for the model: when to call the tool,
   what the values mean, what not to do.
4. **Check, then save.** _Check_ loads the edited files without saving and
   says why they do not load, if they do not. _Save changes_ does the same
   and puts the plugin in force.
5. **Turn it on** for a workspace: Administration → Plugins → _Word count_
   → _Enabled_, set its settings, _Save changes_.
6. **Try it** in the app: "How many words are in: …?" The model calls
   `internal_word_count_count` and answers from its values.
7. **Use a value in an action** (optional). A service action's argument can
   be `"$plugin.result_1.words"`; the server puts in the exact number.

Renaming a tool or adding one means changing both files: the tool list in
`plugin.json` and the `tools` array in `index.ts` must match.

## Editing in the console or as files

**In the console** (Administration → Plugins → a plugin → **Files**): the
server owner (organization role _owner_, not administrators) sees
`plugin.json` and `index.ts` in a plain code editor.

- _Save changes_ validates and loads the files and saves them as the
  plugin's override (built-in) or new version (operator plugin) in the data
  directory. A refused save keeps the editor's text and shows the reason.
- _Reset to built-in_ (menu ⋯, on an override) deletes the data directory's
  copy; the built-in is in force again. On an operator plugin the same menu
  deletes the plugin.
- _Add plugin_ creates one from the template.
- Every save, refused save, reset, delete and creation is audited as
  _Plugin files changed_ (`server.plugin_changed`, with the plugin id).

**As files**: edit `<identity directory>/plugins/<id>/` with any editor and
restart the server; the start reports a plugin that does not load. To change
a built-in, copy `plugins/<id>/` there first. Editing `plugins/` in the
repository changes the built-in for everyone (and is overwritten by an
upgrade of the image).

**Turning console editing off**: set `NIARO_PLUGIN_EDITING=0` (or
`"pluginEditing": false` under `administration.identity` in the profile) and
restart. The owner still sees the files, read-only; saving, resetting and
adding are refused (`plugin_editing_disabled`, audited as refused). Plugins in
the data directory keep loading. `NIARO_PLUGIN_EDITING=1` turns it back on.

## Testing a plugin

- **Check** in the console loads the plugin without saving: manifest, module,
  tool list and schemas.
- **A unit test** imports the module and calls it with the SDK, like the
  server does:

  ```ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { sdk } from "../packages/plugin-sdk";
  import plugin from "../plugins/word-count/index";

  test("counts words", () => {
    const tool = plugin(sdk).tools[0]!;
    const ctx = { settings: { countSpaces: false } } as never;
    assert.deepEqual(
      tool.run(tool.input.parse({ text: "a b" }) as never, ctx),
      {
        status: "resolved",
        values: { words: 2, characters: 2 },
      },
    );
  });
  ```

  Run it with `node --import tsx --test tests/your-test.node.ts`.

- **Against the server's checks**: `preparePlugin(manifest, module.default,
"operator")` from `apps/server-plugins/catalog.ts` runs the same validation
  as a start, and `createInternalPlugins({ enabled: [id], timeZone })` from
  `apps/server-plugins/registry.ts` invokes a pure tool as the agent would
  (see `tests/plugins.node.ts`).
- **Type checking**: a plugin in `plugins/` is part of `npx tsc --noEmit`.

The repository's own tests: `tests/plugins.node.ts` (manifest rules, loading,
overrides, invalid plugins, files), `tests/plugin-files-http.node.ts` (the
console API: owner only, validation, reset, audit, the switch, a tool reaching
the agent), `tests/server-plugins.test.ts` (date arithmetic),
`tests/memory-runtime.node.ts` and the memory suites, and
`tests/web-plugin-files.test.tsx` (the editor page).

## Security

What the server enforces for every plugin, edited or not:

- Only tools declared in `plugin.json` and defined in `index.ts` reach the
  model, under names that cannot collide with server tools.
- Every call's arguments pass the tool's input schema first; at most four
  pure calls per message; pure results are flat, bounded values.
- Write tools are declared, need `explicit_command`, and exist only with the
  memory capability, whose store keeps attribution, revisions and erasure.
- Per-workspace enablement under the profile's allowlist; settings validated
  against the declaration.
- A plugin result never approves an external action.

What it does not enforce: **what the code does**. A plugin runs in the server
process, with its permissions: files of the data volume (including the
identity database and its `secret`), the network, environment variables. An
edited memory plugin could also drop its explicit-command check. Therefore:

- Editing a plugin in the console is running code on the server. Only the
  owner can do it, every change is audited, and the operator can turn it off
  (`NIARO_PLUGIN_EDITING=0`). Turn it off where the owner account is not the
  server's operator, or once the plugins are settled.
- Review plugins like server changes; prefer pure plugins.
- Back up before changing a plugin; the data directory is in the volume
  backup.

## Limits

- No sandbox: plugins are trusted, in-process code.
- An entry module is a single file and cannot import packages at runtime, or
  use top-level `await`.
- Node keeps every saved version of a module in memory until the server
  restarts (each save imports a fresh copy).
- No general key-value store and no network or secret capability for
  plugins yet; write tools exist only for memory.
- Only date & time shows a progress row in the chat; the console's run
  timeline shows other plugins' calls as unknown tools, without arguments.
- The chat runtimes kept for replaying older commands offer only date & time.
