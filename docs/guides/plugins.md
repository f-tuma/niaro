# Writing plugins

A plugin gives the assistant's agent tools that run on the server. It is two
files in a directory named after its id:

```
word-count/
  plugin.json   what the plugin is and what it may do
  index.ts      how its tools work
```

The built-in plugins are the reference examples:
[`plugins/datetime/index.ts`](../../plugins/datetime/index.ts) (a pure
calculation), [`plugins/memory/index.ts`](../../plugins/memory/index.ts)
(write tools that need the person's explicit command) and
[`plugins/web/index.ts`](../../plugins/web/index.ts) (reads through the web
capability).

The rules the server checks (manifest, tool names, effects, results,
enablement, limits) are in
[plugins](../../openspec/specs/plugins/spec.md); the web capability's limits
are in [web-access](../../openspec/specs/web-access/spec.md).

**A plugin is trusted code.** It runs inside the server process with the
server's permissions. See [Security](#security).

## Where plugins live

| What                        | Repository / host                    | Container                        |
| --------------------------- | ------------------------------------ | -------------------------------- |
| Built-in plugins            | `plugins/<id>/`                      | `/app/plugins/<id>/` (read-only) |
| Operator plugins, overrides | `<identity directory>/plugins/<id>/` | `/data/identity/plugins/<id>/`   |
| SDK (types and helpers)     | `packages/plugin-sdk/`               | `/app/packages/plugin-sdk/`      |

The identity directory is `administration.identity.directory` in the
profile, so plugins are in the same backup as the identity data. A plugin
with a built-in's id replaces that built-in (an override).

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

- `effect`: `pure` (computes), `network` (reads the public web; add
  `"capabilities": ["web"]`) or `context` (memory only).
- Tool names of a pure or network plugin start with
  `internal_<id with - as _>_`.
- Raise `version` when the tools behave differently.
- Settings are `boolean`, `integer` (`min`, `max`) or `string` (`maxLength`,
  optional `options`). The console shows a field for each.

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

Import the SDK **as a type only** (`import type`). At runtime the module gets
everything through its argument, so it runs from any directory, including the
data volume. Import only Node built-ins (`node:crypto`, …) at runtime;
`pnpm lint` checks this for `plugins/`. In the repository,
`@niaro/plugin-sdk` maps to `packages/plugin-sdk/index.ts` for the type
checker.

### SDK reference

| Export                                                                                                    | What it is                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `definePlugin({ tools })`                                                                                 | The plugin definition.                                                                                                   |
| `defineTool({ name, description, input, run })`                                                           | One tool. `input` is a zod schema; the model's arguments are validated with it and the model's JSON schema made from it. |
| `resolved(values)`                                                                                        | A pure tool's result: `{ status: "resolved", values }` with flat values.                                                 |
| `z`                                                                                                       | zod, the same instance the server uses.                                                                                  |
| `sdk`                                                                                                     | The object the server passes to the default export (use it in tests).                                                    |
| `PluginSdk`, `ToolContext`, `PureToolResult`, `MemoryCapability`, `WebCapability`, `PluginManifestSchema` | Types, and the manifest schema the server validates with.                                                                |

### ToolContext (`ctx`)

| Field                     | Value                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pluginId`                | The plugin's id.                                                                                             |
| `now`                     | The turn's reference instant (ISO, UTC). A retried turn keeps it.                                            |
| `timeZone`                | The person's IANA zone for the turn: the device's, else the workspace default.                               |
| `settings`                | This workspace's values of the plugin's settings.                                                            |
| `workspaceId`, `personId` | Whom the agent works for.                                                                                    |
| `request`                 | Context tools: the person's latest message (`text`, `commandId`, `conversationId`).                          |
| `memory`                  | The memory plugin: `search`, `remember`, `forget`, `revise`.                                                 |
| `web`                     | Network tools: `search({ query, limit, freshness?, model?, engine?, zeroDataRetention? })` and `fetch(url)`. |
| `log`                     | `info` / `warn` / `error(message, details?)` to the operator log. Never log message content.                 |

Use `ctx.web` instead of Node's network modules: Node's own modules bypass
every check the server applies. A refused or failed `ctx.web` call throws; the
host turns it into an error for the model, so a tool need not catch it.

## Write your first plugin

1. **Create it.** **Built-in tools → Add plugin** (`/admin/plugins`), id
   `word-count`. The server writes the template (the plugin above) to
   `<identity directory>/plugins/word-count/` and opens its files. Without the
   console: copy the two files into that directory and restart.
2. **Change it.** For example, also return the number of sentences: add
   `sentences: input.text.split(/[.!?]+/).filter((s) => s.trim()).length` to
   the values. Write the tool description for the model: when to call it,
   what the values mean, what not to do.
3. **Check**, then **Save changes**. Check loads the edited files without
   saving and says why they do not load. Saving puts the plugin in force
   without a restart.
4. **Turn it on** for a workspace: **Built-in tools → Word count**, _Enabled_,
   set its settings, **Save changes**.
5. **Try it** in the app: "How many words are in: …?" The model calls
   `internal_word_count_count`.
6. **Use a value in an action** (optional): a service action's argument can be
   `"$plugin.result_1.words"`; the server puts in the exact value.

Renaming or adding a tool means changing both files: the tool list in
`plugin.json` and the `tools` array in `index.ts` must match.

## Editing in the console or as files

**In the console** (**Built-in tools** → a plugin → **Files**; organization
owners only):

- **Check** loads the files without saving.
- **Save changes** validates, loads and saves them as the plugin's override
  (built-in) or new version. A refused save keeps your text and shows why.
- **Reset to built-in** (`…` menu, on an override) deletes your copy. On your
  own plugin the same menu has **Delete plugin**.
- Plugins that fail to load at start are listed on the **Built-in tools**
  page under **Tools that did not load**.

**As files:** edit `<identity directory>/plugins/<id>/` and restart the
server; the start log reports a plugin that does not load. To change a
built-in, copy `plugins/<id>/` there first. Editing `plugins/` in the
repository changes the built-in for everyone and is overwritten by an image
upgrade.

**Turning console editing off:** set `NIARO_PLUGIN_EDITING=0` (or
`"pluginEditing": false` under `administration.identity` in the profile) and
restart. The owner can still read the files; plugins in the data directory
keep loading. `NIARO_PLUGIN_EDITING=1` turns it back on.

## Server profile

Which plugins workspaces may use, and the default time zone, are set in the
profile's `plugins` block:

```json
"plugins": {
  "enabled": ["datetime"],
  "timeZone": "Europe/Prague"
}
```

Set the time zone explicitly; without it the server uses `UTC`. The time zone
is also editable in **Settings**. `enabled` may name your own plugins too, to
have them on for workspaces that keep the server's defaults.

Memory is opt-in. Add it to the allowlist; explicit `memory` values are
ceilings a workspace can only lower:

```json
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
```

Server-wide values for other plugins' declared settings go under
`plugins.settings.<plugin id>`.

## Testing a plugin

- **Check** in the console: manifest, module, tool list and schemas.
- **A unit test** calls the module with the SDK, as the server does:

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
      { status: "resolved", values: { words: 2, characters: 2 } },
    );
  });
  ```

  Run it with `node --import tsx --test tests/your-test.node.ts`.

- **Against the server's checks:** `preparePlugin(manifest, module.default,
"operator")` from `apps/server-plugins/catalog.ts` runs the same validation
  as a server start. `createInternalPlugins({ enabled: [id], timeZone })` from
  `apps/server-plugins/registry.ts` invokes a pure tool as the agent would
  (see `tests/plugins.node.ts`).
- **Types:** a plugin in `plugins/` is part of `pnpm typecheck`.

## Security

The server checks what a plugin declares, not what its code does. A plugin
can read the data volume (including the identity database and its secret),
reach the network and read environment variables. An edited memory plugin
could drop its explicit-command check for corrections and deletions; the
server's own check that a saved fact is in the person's words stays.

- Review plugins like server changes; prefer pure plugins.
- Editing a plugin in the console is running code on the server. Turn editing
  off (`NIARO_PLUGIN_EDITING=0`) where the owner account is not the server's
  operator, or once the plugins are settled.
- Back up before changing a plugin; the plugins directory is in the volume
  backup.
