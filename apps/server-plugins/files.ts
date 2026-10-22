import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PLUGIN_ID_PATTERN } from "../../packages/plugin-sdk";
import {
  builtInPlugin,
  builtInPluginsDirectory,
  importPlugin,
  pluginCatalog,
  PluginLoadError,
  PLUGIN_FILES,
  replacePlugin,
  errorText,
  type LoadedPlugin,
  type PluginFileName,
} from "./catalog";
import { pluginTemplate } from "./template";

export type PluginFileSet = Record<PluginFileName, string>;
export class PluginFilesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * plugin.json and index.ts of the plugins, as the console edits them. Saved
 * files go to the data directory: an override of a built-in plugin, or an
 * operator plugin. Nothing is written or put in force before the new files
 * validated and loaded from a staging copy.
 */
export class PluginFiles {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly builtInDirectory = builtInPluginsDirectory(),
  ) {}
  /** One change at a time: staging, renames and the catalog stay consistent. */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private own(id: string) {
    if (!PLUGIN_ID_PATTERN.test(id))
      throw new PluginFilesError(400, "plugin_id_invalid");
    return join(this.directory, id);
  }
  private readFrom(directory: string): PluginFileSet {
    return Object.fromEntries(
      PLUGIN_FILES.map((name) => {
        try {
          return [name, readFileSync(join(directory, name), "utf8")];
        } catch {
          return [name, ""];
        }
      }),
    ) as PluginFileSet;
  }
  /** The files in force: the data directory's copy, else the built-in ones. */
  read(id: string) {
    const own = this.own(id);
    const plugin = pluginCatalog().plugins.get(id);
    const builtIn = !!builtInPlugin(id);
    if (existsSync(own)) {
      const problem =
        pluginCatalog().problems.find((entry) => entry.directory === id)
          ?.message ?? null;
      return {
        source:
          plugin && plugin.source !== "built-in" && !problem
            ? plugin.source
            : null,
        builtIn,
        directory: own,
        files: this.readFrom(own),
        problem,
      };
    }
    if (!builtIn) throw new PluginFilesError(404, "plugin_not_found");
    const directory = join(this.builtInDirectory, id);
    return {
      source: "built-in" as const,
      builtIn,
      directory,
      files: this.readFrom(directory),
      problem: null,
    };
  }
  /** Writes the files to a staging directory and loads them from there. */
  private async stage(id: string, files: PluginFileSet) {
    const staging = join(
      this.directory,
      ".staging",
      `${id}-${randomBytes(6).toString("hex")}`,
    );
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const name of PLUGIN_FILES)
      writeFileSync(join(staging, name), files[name], { mode: 0o600 });
    try {
      return { staging, plugin: await importPlugin(staging, id) };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      return {
        problem:
          error instanceof PluginLoadError ? error.message : errorText(error),
      };
    }
  }
  /** Validates and loads without saving. Returns why the files were refused, or null. */
  async check(id: string, files: PluginFileSet) {
    this.own(id);
    const staged = await this.stage(id, files);
    if ("problem" in staged) return staged.problem;
    rmSync(staged.staging, { recursive: true, force: true });
    return null;
  }
  /** Validates, loads, saves and puts the plugin in force; or returns why not. */
  async save(id: string, files: PluginFileSet) {
    const target = this.own(id);
    const staged = await this.stage(id, files);
    if ("problem" in staged) return staged.problem;
    this.place(staged.staging, target);
    replacePlugin(id, staged.plugin);
    return null;
  }
  private place(staging: string, target: string) {
    const trash = join(
      this.directory,
      ".staging",
      `trash-${randomBytes(6).toString("hex")}`,
    );
    if (existsSync(target)) renameSync(target, trash);
    renameSync(staging, target);
    rmSync(trash, { recursive: true, force: true });
    rmSync(join(this.directory, ".staging"), { recursive: true, force: true });
  }
  /** Removes the data directory's copy: the built-in plugin again, or none. */
  reset(id: string) {
    const target = this.own(id);
    if (!existsSync(target))
      throw new PluginFilesError(404, "plugin_not_found");
    rmSync(target, { recursive: true, force: true });
    replacePlugin(id, null);
  }
  /** A new operator plugin from the template. */
  async create(id: string): Promise<LoadedPlugin> {
    const target = this.own(id);
    if (pluginCatalog().plugins.has(id) || existsSync(target))
      throw new PluginFilesError(409, "plugin_exists");
    const staged = await this.stage(id, pluginTemplate(id));
    if ("problem" in staged)
      throw new Error(`plugin_template_invalid: ${staged.problem}`);
    this.place(staged.staging, target);
    replacePlugin(id, staged.plugin);
    return staged.plugin;
  }
}
