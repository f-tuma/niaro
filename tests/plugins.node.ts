import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  PluginManifestSchema,
  resolveSettings,
  sdk,
  settingValid,
  toolParameters,
} from "../packages/plugin-sdk";
import {
  builtInPlugin,
  loadPlugins,
  pluginCatalog,
  preparePlugin,
  PluginLoadError,
} from "../apps/server-plugins/catalog";
import { PluginFiles } from "../apps/server-plugins/files";
import { pluginTemplate } from "../apps/server-plugins/template";
import {
  createInternalPlugins,
  PluginSettingsSchema,
} from "../apps/server-plugins/registry";
import { DateTimeInput } from "../packages/protocol/internal-plugins";
import {
  MEMORY_DEFAULTS,
  MemorySettingsSchema,
} from "../packages/protocol/memory";
import {
  createMemoryRuntime,
  memoryToolNames,
} from "../apps/server-identity/memory-runtime";
import { MemoryStore } from "../apps/server-identity/memory";

const builtIns = join(process.cwd(), "plugins");
const read = (id: string, name: string) =>
  readFileSync(join(builtIns, id, name), "utf8");
const clock = {
  referenceNow: "2026-09-27T21:30:00.000Z",
  timeZone: "Europe/Prague",
};
function plugin(directory: string, files: Record<string, string>) {
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(directory, name), content);
}
const manifest = (patch: object = {}) => ({
  id: "word-count",
  version: 1,
  name: { en: "TEST", cs: "TEST" },
  description: { en: "TEST", cs: "TEST" },
  effect: "pure",
  tools: [
    {
      name: "internal_word_count_count",
      title: { en: "TEST", cs: "TEST" },
      access: "read",
      approval: "none",
    },
  ],
  ...patch,
});

test("plugin.json: the built-ins validate and the safety rules refuse what the server cannot honour", () => {
  for (const id of ["datetime", "memory"])
    assert.equal(
      PluginManifestSchema.safeParse(JSON.parse(read(id, "plugin.json")))
        .success,
      true,
      id,
    );
  assert.equal(PluginManifestSchema.safeParse(manifest()).success, true);
  const tool = manifest().tools[0]!;
  for (const [label, value] of [
    ["unknown field", manifest({ remote: "https://example.test" })],
    ["id", manifest({ id: "Word Count" })],
    [
      "write without explicit command",
      manifest({ tools: [{ ...tool, access: "write" }] }),
    ],
    [
      "read with explicit command",
      manifest({ tools: [{ ...tool, approval: "explicit_command" }] }),
    ],
    [
      "tool outside the plugin's namespace",
      manifest({ tools: [{ ...tool, name: "action_send_mail" }] }),
    ],
    ["duplicate tools", manifest({ tools: [tool, tool] })],
    [
      "memory capability outside memory",
      manifest({ effect: "context", capabilities: ["memory"] }),
    ],
    ["context without a capability", manifest({ effect: "context" })],
    [
      "setting default out of range",
      manifest({
        settings: {
          limit: {
            type: "integer",
            label: { en: "TEST", cs: "TEST" },
            default: 50,
            min: 1,
            max: 10,
          },
        },
      }),
    ],
  ] as const)
    assert.equal(PluginManifestSchema.safeParse(value).success, false, label);
});

test("settings resolve from declared defaults and valid layers only", () => {
  const fields = PluginManifestSchema.parse(
    manifest({
      settings: {
        limit: {
          type: "integer",
          label: { en: "TEST", cs: "TEST" },
          default: 5,
          min: 1,
          max: 10,
        },
        mode: {
          type: "string",
          label: { en: "TEST", cs: "TEST" },
          default: "short",
          options: ["short", "long"],
        },
      },
    }),
  ).settings;
  assert.deepEqual(
    resolveSettings(fields, { limit: 8, mode: "wide" }, { limit: 99 }),
    { limit: 8, mode: "short" },
  );
  assert.equal(settingValid(fields.limit!, 3.5), false);
  assert.equal(settingValid(fields.mode!, "long"), true);
});

test("the rewritten plugins keep their model contracts", () => {
  const dateTime = builtInPlugin("datetime")!;
  // The tool schema the model sees is generated from the plugin's own input
  // schema and matches the preview API's (protocol) schema.
  assert.deepEqual(
    dateTime.modelTools[0]!.function.parameters,
    toolParameters({ input: DateTimeInput }),
  );
  assert.deepEqual(
    builtInPlugin("memory")!.modelTools.map((tool) => tool.function.name),
    ["memory_search", "memory_remember", "memory_revise", "memory_forget"],
  );
  assert.deepEqual(memoryToolNames(), [
    "memory_search",
    "memory_remember",
    "memory_revise",
    "memory_forget",
  ]);
  // plugin.json documents the same bounds the memory store enforces.
  const fields = builtInPlugin("memory")!.manifest.settings;
  assert.deepEqual(resolveSettings(fields), MEMORY_DEFAULTS);
  for (const [key, field] of Object.entries(fields))
    if (field.type === "integer")
      for (const [value, valid] of [
        [field.min, true],
        [field.max, true],
        [field.min - 1, false],
        [field.max + 1, false],
      ] as const)
        assert.equal(
          MemorySettingsSchema.safeParse({ [key]: value }).success,
          valid,
          `${key}=${value}`,
        );
});

test("an entry module is checked against its manifest", () => {
  const raw = manifest();
  const good = ({ definePlugin, defineTool, resolved, z }: typeof sdk) =>
    definePlugin({
      tools: [
        defineTool({
          name: "internal_word_count_count",
          description: "TEST",
          input: z.strictObject({ text: z.string() }),
          run: (input) => resolved({ words: input.text.split(" ").length }),
        }),
      ],
    });
  assert.equal(preparePlugin(raw, good, "operator").tools.size, 1);
  const refused = (exported: unknown, pattern: RegExp) =>
    assert.throws(
      () => preparePlugin(raw, exported, "operator"),
      (error: Error) =>
        error instanceof PluginLoadError && pattern.test(error.message),
    );
  refused({ tools: [] }, /default-export a function/);
  refused(() => {
    throw Error("TEST boom");
  }, /TEST boom/);
  refused(
    ({ definePlugin }: typeof sdk) => definePlugin({ tools: [] }),
    /missing in index.ts: internal_word_count_count/,
  );
  refused(
    ({ definePlugin, defineTool, z }: typeof sdk) =>
      definePlugin({
        tools: [
          defineTool({
            name: "internal_word_count_count",
            description: "TEST",
            input: z.string(),
            run: () => ({}),
          }),
        ],
      }),
    /input must be an object/,
  );
});

test("loading: built-ins, an override, an operator plugin, and invalid plugins that are skipped", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugins-load-"));
  t.after(async () => {
    await loadPlugins();
    rmSync(root, { recursive: true, force: true });
  });
  // An override of datetime that always answers the same instant.
  plugin(join(root, "datetime"), {
    "plugin.json": read("datetime", "plugin.json").replace(
      '"version": 1',
      '"version": 2',
    ),
    "index.ts": `import type { PluginSdk } from "@niaro/plugin-sdk";
export default ({ definePlugin, defineTool, resolved, z }: PluginSdk) =>
  definePlugin({ tools: [defineTool({
    name: "internal_datetime_resolve",
    description: "TEST override",
    input: z.object({ when: z.unknown() }),
    run: (_input, ctx) => resolved({ utc: ctx.now, zone: ctx.timeZone }),
  })] });
`,
  });
  plugin(join(root, "word-count"), pluginTemplate("word-count"));
  plugin(join(root, "broken"), {
    "plugin.json": JSON.stringify(manifest({ id: "broken", tools: [] })),
    "index.ts": "export default () => ({ tools: [] });",
  });
  plugin(join(root, "syntax"), {
    ...pluginTemplate("syntax"),
    "index.ts": "export default () => ({ tools: [ ;",
  });
  plugin(join(root, "imports"), {
    ...pluginTemplate("imports"),
    // A runtime package import does not resolve outside the application.
    "index.ts": 'import { z } from "zod";\nexport default () => z;\n',
  });
  plugin(join(root, "renamed"), pluginTemplate("other"));
  plugin(join(root, "Bad Name"), pluginTemplate("bad"));
  // An override of memory that drops a tool keeps the built-in in force.
  const memory = JSON.parse(read("memory", "plugin.json"));
  memory.tools = memory.tools.filter(
    (tool: { name: string }) => tool.name !== "memory_forget",
  );
  plugin(join(root, "memory"), {
    "plugin.json": JSON.stringify(memory),
    "index.ts": read("memory", "index.ts").replace(
      "[search, remember, revise, forget]",
      "[search, remember, revise]",
    ),
  });
  const catalog = await loadPlugins({ dataDirectory: root });
  assert.deepEqual(
    [...catalog.plugins].map(([id, value]) => [id, value.source]),
    [
      ["datetime", "override"],
      ["memory", "built-in"],
      ["web", "built-in"],
      ["word-count", "operator"],
    ],
  );
  const problems = Object.fromEntries(
    catalog.problems.map((problem) => [problem.directory, problem.message]),
  );
  assert.deepEqual(Object.keys(problems).sort(), [
    "Bad Name",
    "broken",
    "imports",
    "memory",
    "renamed",
    "syntax",
  ]);
  assert.match(problems.broken!, /plugin\.json → tools/);
  assert.match(problems.syntax!, /index\.ts does not load/);
  assert.match(problems.imports!, /index\.ts does not load/);
  assert.match(problems.renamed!, /must be renamed/);
  assert.match(problems.memory!, /keeps its tools: memory_forget/);

  // The override answers the agent's calls; settings validate against the new catalog.
  const registry = createInternalPlugins({
    enabled: ["datetime", "word-count"],
    timeZone: "Europe/Prague",
    settings: { "word-count": { countSpaces: true } },
  });
  assert.deepEqual(
    registry.invoke("internal_datetime_resolve", { when: {} }, clock, 1),
    {
      ref: "result_1",
      name: "internal_datetime_resolve",
      version: 2,
      input: { when: {} },
      result: {
        status: "resolved",
        values: { utc: clock.referenceNow, zone: "Europe/Prague" },
      },
    },
  );
  assert.deepEqual(
    registry.invoke("internal_word_count_count", { text: "a b  c" }, clock, 2)
      .result,
    { status: "resolved", values: { words: 3, characters: 6 } },
  );
  assert.equal(registry.progress("internal_word_count_count"), undefined);
  assert.equal(
    registry.failure("internal_word_count_count"),
    "invalid_plugin_arguments",
  );
  assert.throws(() =>
    registry.invoke("internal_word_count_count", { text: 1 }, clock, 3),
  );
  // Replay runtimes keep to date & time.
  assert.deepEqual(
    createInternalPlugins(
      { enabled: ["datetime", "word-count"], timeZone: "UTC" },
      { legacy: true },
    ).tools.map((tool) => tool.function.name),
    ["internal_datetime_resolve"],
  );
  assert.equal(
    PluginSettingsSchema.safeParse({ enabled: ["word-count"] }).success,
    true,
  );
  assert.equal(
    PluginSettingsSchema.safeParse({ enabled: ["broken"] }).success,
    false,
  );
});

test("a pure tool must answer synchronously with flat values", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugins-result-"));
  t.after(async () => {
    await loadPlugins();
    rmSync(root, { recursive: true, force: true });
  });
  const template = pluginTemplate("odd");
  plugin(join(root, "odd"), {
    ...template,
    "index.ts": template["index.ts"].replace(
      "return resolved({ words, characters });",
      "return input.text === 'async' ? Promise.resolve(resolved({ words })) : { status: 'resolved', values: { nested: { words } } };",
    ),
  });
  await loadPlugins({ dataDirectory: root });
  const registry = createInternalPlugins({ enabled: ["odd"], timeZone: "UTC" });
  assert.throws(
    () => registry.invoke("internal_odd_count", { text: "async" }, clock, 1),
    /internal_plugin_async/,
  );
  assert.throws(
    () => registry.invoke("internal_odd_count", { text: "x" }, clock, 1),
    /internal_plugin_result_invalid/,
  );
});

test("plugin files: check, save as override, reset, create and delete", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugins-files-"));
  t.after(async () => {
    await loadPlugins();
    rmSync(root, { recursive: true, force: true });
  });
  await loadPlugins({ dataDirectory: root });
  const files = new PluginFiles(root, builtIns);
  const original = files.read("datetime");
  assert.equal(original.source, "built-in");
  assert.equal(original.files["index.ts"], read("datetime", "index.ts"));
  assert.throws(() => files.read("missing"), /plugin_not_found/);
  assert.throws(() => files.read("../etc"), /plugin_id_invalid/);

  const broken = { ...original.files, "index.ts": "export default 1;" };
  assert.match(
    (await files.check("datetime", broken))!,
    /default-export a function/,
  );
  assert.match((await files.save("datetime", broken))!, /default-export/);
  assert.equal(existsSync(join(root, "datetime")), false, "nothing saved");
  assert.equal(pluginCatalog().plugins.get("datetime")!.source, "built-in");
  assert.match(
    (await files.save("datetime", {
      ...original.files,
      "plugin.json": original.files["plugin.json"].replace(
        '"id": "datetime"',
        '"id": "other"',
      ),
    }))!,
    /must be datetime/,
  );

  const edited = {
    ...original.files,
    "index.ts": original.files["index.ts"].replace(
      "Calculate an exact time on the server",
      "TEST edited: calculate exact dates/times on the server",
    ),
  };
  assert.equal(await files.check("datetime", edited), null);
  assert.equal(
    existsSync(join(root, "datetime")),
    false,
    "check saves nothing",
  );
  assert.equal(await files.save("datetime", edited), null);
  assert.equal(files.read("datetime").source, "override");
  assert.match(
    createInternalPlugins({ enabled: ["datetime"], timeZone: "UTC" }).tools[0]!
      .function.description,
    /^TEST edited/,
  );
  // Saved twice: the second version replaces the first.
  assert.equal(
    await files.save("datetime", {
      ...edited,
      "index.ts": edited["index.ts"].replace("TEST edited", "TEST again"),
    }),
    null,
  );
  assert.match(
    pluginCatalog().plugins.get("datetime")!.modelTools[0]!.function
      .description,
    /^TEST again/,
  );
  assert.equal(existsSync(join(root, ".staging")), false, "no staging left");
  files.reset("datetime");
  assert.equal(files.read("datetime").source, "built-in");
  assert.equal(pluginCatalog().plugins.get("datetime")!.source, "built-in");
  assert.throws(() => files.reset("datetime"), /plugin_not_found/);

  await files.create("hello");
  assert.equal(files.read("hello").source, "operator");
  await assert.rejects(files.create("hello"), /plugin_exists/);
  await assert.rejects(files.create("memory"), /plugin_exists/);
  // The new plugin survives a restart.
  await loadPlugins({ dataDirectory: root });
  assert.equal(pluginCatalog().plugins.get("hello")?.source, "operator");
  files.reset("hello");
  assert.equal(pluginCatalog().plugins.has("hello"), false);
  assert.throws(() => files.read("hello"), /plugin_not_found/);
});

test("a memory override runs through the host's memory capability", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugins-memory-"));
  t.after(async () => {
    await loadPlugins();
    rmSync(root, { recursive: true, force: true });
  });
  plugin(join(root, "memory"), {
    "plugin.json": read("memory", "plugin.json"),
    "index.ts": read("memory", "index.ts").replace(
      "run: (input, ctx) => ctx.memory!.search(input.query),",
      "run: async (input, ctx) => ({ ...(await ctx.memory!.search(input.query)), plugin: ctx.pluginId, person: ctx.personId }),",
    ),
  });
  await loadPlugins({ dataDirectory: root });
  assert.equal(pluginCatalog().plugins.get("memory")!.source, "override");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE user(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT REFERENCES organization(id)) STRICT;
    INSERT INTO organization VALUES('org'); INSERT INTO user VALUES('alice');
    INSERT INTO agent_workspace VALUES('workspace','org');`);
  const store = new MemoryStore(db, { secret: "NIARO TEST plugin memory key" });
  const runtime = createMemoryRuntime(
    store,
    {
      organizationId: "org",
      workspaceId: "workspace",
      userId: "alice",
      canManageShared: false,
    },
    MemorySettingsSchema.parse({}),
    {
      read: async (fn) => fn(),
      mutate: async (fn) => fn(),
      check: () => {},
      sourceAccess: () => true,
    },
  );
  const meta = { commandId: "TEST-command", callId: "TEST-call" };
  assert.deepEqual(
    await runtime.invoke!(
      "memory_remember",
      { content: "TEST", kind: "note" },
      {
        ...meta,
        text: "What is TEST?",
      },
    ),
    { error: "memory_explicit_instruction_required" },
  );
  const saved = (await runtime.invoke!(
    "memory_remember",
    { content: "TEST fact", kind: "fact" },
    { ...meta, text: "Remember: TEST fact" },
  )) as { status: string };
  assert.equal(saved.status, "active");
  const found = (await runtime.invoke!(
    "memory_search",
    { query: "TEST fact" },
    {
      ...meta,
      text: "TEST",
    },
  )) as { plugin: string; person: string; items: { content: string }[] };
  assert.equal(found.plugin, "memory");
  assert.equal(found.person, "alice");
  assert.deepEqual(
    found.items.map((item) => item.content),
    ["TEST fact"],
  );
  await assert.rejects(
    runtime.invoke!("memory_search", { query: 1 }, { ...meta, text: "" }),
    z.ZodError,
  );
});
