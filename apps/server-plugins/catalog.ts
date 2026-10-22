import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  manifestProblem,
  PLUGIN_ID_PATTERN,
  PluginManifestSchema,
  sdk,
  toolParameters,
  type PluginDefinition,
  type PluginManifest,
  type ToolDefinition,
} from "../../packages/plugin-sdk";
import { operatorLog } from "../fixture-server/operator-log";
import dateTimeManifest from "../../plugins/datetime/plugin.json";
import dateTimeModule from "../../plugins/datetime/index";
import memoryManifest from "../../plugins/memory/plugin.json";
import memoryModule from "../../plugins/memory/index";

/**
 * The plugins this server runs. Built-in plugins (plugins/ in the repository
 * and the image) are compiled in; operator plugins come from the data
 * directory (<identity directory>/plugins). One with the id of a built-in
 * replaces it. A plugin that does not validate or load is reported and
 * skipped; the server keeps the built-in, or runs without it.
 *
 * Plugins run in-process: a plugin is trusted code with the server's
 * permissions. See docs/plugins.md.
 */
export type PluginSource = "built-in" | "override" | "operator";
export type LoadedPlugin = {
  manifest: PluginManifest;
  source: PluginSource;
  tools: Map<string, ToolDefinition>;
  /** The function-tool definitions the model sees, in plugin order. */
  modelTools: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }[];
};
export type PluginProblem = {
  /** The directory name under the plugins directory. */
  directory: string;
  id: string | null;
  message: string;
};
export type PluginCatalog = {
  plugins: Map<string, LoadedPlugin>;
  problems: PluginProblem[];
};
export const PLUGIN_FILES = ["plugin.json", "index.ts"] as const;
export type PluginFileName = (typeof PLUGIN_FILES)[number];
export const MAX_PLUGIN_FILE_BYTES = 256 * 1024;
const MAX_OPERATOR_PLUGINS = 50;

export class PluginLoadError extends Error {}

/** Checks a manifest and an entry module's default export against each other. */
export function preparePlugin(
  rawManifest: unknown,
  exported: unknown,
  source: PluginSource,
): LoadedPlugin {
  const parsed = PluginManifestSchema.safeParse(rawManifest);
  if (!parsed.success) throw new PluginLoadError(manifestProblem(parsed.error));
  const manifest = parsed.data;
  if (typeof exported !== "function")
    throw new PluginLoadError(
      "index.ts must default-export a function: export default (sdk) => sdk.definePlugin({...})",
    );
  let definition: PluginDefinition;
  try {
    definition = (exported as (value: typeof sdk) => PluginDefinition)(sdk);
  } catch (error) {
    throw new PluginLoadError(`index.ts failed: ${errorText(error)}`);
  }
  if (!definition || !Array.isArray(definition.tools))
    throw new PluginLoadError("definePlugin needs a tools array");
  const tools = new Map<string, ToolDefinition>();
  for (const tool of definition.tools as ToolDefinition[]) {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      typeof tool.run !== "function" ||
      typeof tool.input?.safeParse !== "function"
    )
      throw new PluginLoadError(
        "Every tool needs a name, a description, an input schema and run",
      );
    if (!tool.description.trim() || tool.description.length > 4000)
      throw new PluginLoadError(
        `${tool.name}: the description needs 1–4,000 characters`,
      );
    if (tools.has(tool.name))
      throw new PluginLoadError(`${tool.name} is defined twice`);
    tools.set(tool.name, tool);
  }
  const declared = manifest.tools.map((tool) => tool.name);
  const missing = declared.filter((name) => !tools.has(name));
  const extra = [...tools.keys()].filter((name) => !declared.includes(name));
  if (missing.length || extra.length)
    throw new PluginLoadError(
      `plugin.json and index.ts must offer the same tools${missing.length ? `; missing in index.ts: ${missing.join(", ")}` : ""}${extra.length ? `; not in plugin.json: ${extra.join(", ")}` : ""}`,
    );
  const modelTools = manifest.tools.map((entry) => {
    const tool = tools.get(entry.name)!;
    let parameters: Record<string, unknown>;
    try {
      parameters = toolParameters(tool);
    } catch (error) {
      throw new PluginLoadError(
        `${tool.name}: the input schema has no JSON schema (${errorText(error)})`,
      );
    }
    if (parameters.type !== "object")
      throw new PluginLoadError(`${tool.name}: the input must be an object`);
    return {
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters },
    };
  });
  return { manifest, source, tools, modelTools };
}

const builtIns = new Map<string, LoadedPlugin>(
  (
    [
      [dateTimeManifest, dateTimeModule],
      [memoryManifest, memoryModule],
    ] as const
  ).map(([manifest, module]) => {
    const plugin = preparePlugin(manifest, module, "built-in");
    return [plugin.manifest.id, plugin];
  }),
);
let current: PluginCatalog = { plugins: new Map(builtIns), problems: [] };

/** The plugins in force. Before loadPlugins, the built-in ones. */
export function pluginCatalog(): PluginCatalog {
  return current;
}
export function builtInPlugin(id: string) {
  return builtIns.get(id);
}
/** Where the built-in plugins' files are: plugins/ of the application. */
export function builtInPluginsDirectory() {
  return resolve(process.cwd(), "plugins");
}

/** An override must keep what the server relies on: effect and every tool name. */
function checkOverride(plugin: LoadedPlugin) {
  const base = builtIns.get(plugin.manifest.id);
  if (!base) return;
  if (base.manifest.effect !== plugin.manifest.effect)
    throw new PluginLoadError(
      `An override of ${base.manifest.id} keeps effect ${base.manifest.effect}`,
    );
  const missing = [...base.tools.keys()].filter(
    (name) => !plugin.tools.has(name),
  );
  if (missing.length)
    throw new PluginLoadError(
      `An override of ${base.manifest.id} keeps its tools: ${missing.join(", ")}`,
    );
}

/** Reads and imports one plugin directory. Throws PluginLoadError with a readable reason. */
export async function importPlugin(
  directory: string,
  expectedId?: string,
): Promise<LoadedPlugin> {
  const files = Object.fromEntries(
    PLUGIN_FILES.map((name) => {
      const path = join(directory, name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        throw new PluginLoadError(`${name} is missing`);
      }
      if (!stats.isFile() || stats.size > MAX_PLUGIN_FILE_BYTES)
        throw new PluginLoadError(`${name} must be a file of at most 256 KB`);
      return [name, readFileSync(path, "utf8")];
    }),
  ) as Record<PluginFileName, string>;
  let raw: unknown;
  try {
    raw = JSON.parse(files["plugin.json"]);
  } catch (error) {
    throw new PluginLoadError(`plugin.json is not JSON: ${errorText(error)}`);
  }
  const named = (raw as { id?: unknown } | null)?.id;
  const id = typeof named === "string" ? named : undefined;
  if (expectedId && id !== expectedId)
    throw new PluginLoadError(
      `The id in plugin.json must be ${expectedId}, the directory's name`,
    );
  let exported: unknown;
  try {
    // The query makes the import fresh whenever the source changed; Node
    // keeps every imported version in memory until the server restarts.
    const version = createHash("sha256")
      .update(files["index.ts"])
      .digest("hex")
      .slice(0, 16);
    const module = (await import(
      `${pathToFileURL(join(directory, "index.ts")).href}?v=${version}`
    )) as { default?: unknown };
    exported = module.default;
  } catch (error) {
    throw new PluginLoadError(`index.ts does not load: ${errorText(error)}`);
  }
  const plugin = preparePlugin(
    raw,
    exported,
    id && builtIns.has(id) ? "override" : "operator",
  );
  checkOverride(plugin);
  return plugin;
}

/** The plugin directories in a data directory, in name order. */
export function pluginDirectories(dataDirectory: string) {
  if (!existsSync(dataDirectory)) return [];
  return readdirSync(dataDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Loads built-in and operator plugins and puts them in force. Never throws
 * for a plugin: each invalid one becomes a problem in the catalog and a
 * warning in the operator log.
 */
export async function loadPlugins(
  options: { dataDirectory?: string } = {},
): Promise<PluginCatalog> {
  const plugins = new Map(builtIns);
  const problems: PluginProblem[] = [];
  const names = options.dataDirectory
    ? pluginDirectories(options.dataDirectory)
    : [];
  for (const [index, name] of names.entries()) {
    const problem = (message: string, id: string | null = null) => {
      problems.push({ directory: name, id, message });
      operatorLog(
        "plugin_invalid",
        { directory: name, ...(id ? { plugin: id } : {}), message },
        "warn",
      );
    };
    if (!PLUGIN_ID_PATTERN.test(name)) {
      problem("The directory name is not a plugin id (a-z, 0-9, -)");
      continue;
    }
    if (index >= MAX_OPERATOR_PLUGINS) {
      problem(`At most ${MAX_OPERATOR_PLUGINS} plugins load`, name);
      continue;
    }
    try {
      const plugin = await importPlugin(
        join(options.dataDirectory!, name),
        name,
      );
      plugins.set(name, plugin);
      operatorLog("plugin_loaded", {
        plugin: name,
        source: plugin.source,
        version: plugin.manifest.version,
      });
    } catch (error) {
      problem(
        error instanceof PluginLoadError ? error.message : errorText(error),
        name,
      );
    }
  }
  current = { plugins, problems };
  return current;
}

/** Puts one plugin in force (saved in the console), or removes it (null). */
export function replacePlugin(id: string, plugin: LoadedPlugin | null) {
  const plugins = new Map(current.plugins);
  const fallback = builtIns.get(id);
  if (plugin) plugins.set(id, plugin);
  else if (fallback) plugins.set(id, fallback);
  else plugins.delete(id);
  current = {
    plugins,
    problems: current.problems.filter((problem) => problem.directory !== id),
  };
}

export function errorText(error: unknown) {
  const text =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return text.replace(/\s+/g, " ").trim().slice(0, 1000);
}
